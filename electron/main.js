/**
 * Proces główny Electrona: okno aplikacji, magazyn danych, obsługa IPC.
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Menu, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../shared/store.js';
import { ScanService } from '../shared/service.js';
import { detectReaders } from './reader.js';
import { fileAdapter } from './persistence.js';
import { PhoneBridge } from './bridge.js';
import { SecretStore } from './secrets.js';
import { RestAdapter } from './rest-adapter.js';
import { HttpClient } from './http-client.js';
import { IntegrationService, handoverCsv, handoverRows } from '../shared/integration.js';
import { AKUVOX_CAVEATS, AKUVOX_PROFILE, AKUVOX_REGIONS, CARD_FORMATS } from '../shared/akuvox-profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * Okno ładujemy z serwera Vite tylko wtedy, gdy naprawdę pracujemy nad kodem
 * (`npm run dev`). Samo uruchomienie niespakowanego Electrona (`npm start`)
 * ma korzystać ze zbudowanych plików z katalogu dist.
 */
const useDevServer = process.env.NODE_ENV === 'development';
const isDev = useDevServer || !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

let store;
let service;
let bridge;
let secrets;
let integration;
let integrationHttp;
let mainWindow = null;

function dataFile() {
  // W trybie deweloperskim trzymamy bazę w repo, żeby łatwo ją podejrzeć.
  if (isDev && !process.env.RFID_USE_USERDATA) {
    return path.join(app.getAppPath(), 'data', 'rfid-data.json');
  }
  return path.join(app.getPath('userData'), 'rfid-data.json');
}

/**
 * Adapter chmury budowany z aktywnego połączenia.
 *
 * Instalator obsługuje kilku klientów, więc poświadczenia są per połączenie,
 * a nie globalne. Adapter tworzymy raz na konfigurację, bo token żyje w jego
 * instancji — przebudowa przy każdej operacji oznaczałaby logowanie za każdym
 * razem.
 */
let adapterCache = null;
let adapterKey = '';

/** Klucze sekretów są przypisane do połączenia, nie do aplikacji. */
function secretKey(connectionId, field) {
  return `akuvox:${connectionId}:${field}`;
}

function activeConnection() {
  return store.activeConnection();
}

function akuvoxAdapter() {
  const conn = activeConnection();
  if (!conn) throw new Error('Nie ma żadnego połączenia z chmurą — dodaj je w zakładce Akuvox.');

  const profile = {
    ...AKUVOX_PROFILE,
    providerId: 'akuvox',
    baseUrl: conn.baseUrl || AKUVOX_PROFILE.baseUrl,
    cardFormat: conn.cardFormat,
  };
  const credentials = {
    clientId: conn.clientId,
    clientSecret: secrets.get(secretKey(conn.id, 'clientSecret')),
    username: conn.username,
    password: secrets.get(secretKey(conn.id, 'password')),
  };

  const key = JSON.stringify([conn.id, profile.baseUrl, profile.cardFormat, credentials.clientId,
    credentials.username, Boolean(credentials.clientSecret), Boolean(credentials.password), conn.dryRun]);
  if (adapterCache && adapterKey === key) return adapterCache;

  integrationHttp = new HttpClient({ retries: 2, timeoutMs: 15_000, dryRun: conn.dryRun, logSize: 60 });
  adapterCache = new RestAdapter({ profile, credentials, http: integrationHttp });
  adapterKey = key;
  return adapterCache;
}

function connectionState(conn) {
  const missing = [];
  if (!conn.baseUrl) missing.push('adres serwera');
  if (!conn.clientId) missing.push('client_id');
  if (!secrets.has(secretKey(conn.id, 'clientSecret'))) missing.push('client_secret');
  if (!conn.username) missing.push('login zarządcy');
  if (!secrets.has(secretKey(conn.id, 'password'))) missing.push('hasło zarządcy');
  return {
    ...conn,
    hasClientSecret: secrets.has(secretKey(conn.id, 'clientSecret')),
    hasPassword: secrets.has(secretKey(conn.id, 'password')),
    configured: missing.length === 0,
    missing,
    linkedCards: store.listCards().filter((c) => c.link.connectionId === conn.id).length,
  };
}

function akuvoxStatus() {
  const s = store.getSettings();
  const conn = activeConnection();
  return {
    connections: store.listConnections().map(connectionState),
    activeId: conn?.id || '',
    active: conn ? connectionState(conn) : null,
    installerName: s.installerName,
    offlineQueue: s.offlineQueue,
    autoSync: s.autoSync,
    secretStorageAvailable: secrets.available,
    regions: AKUVOX_REGIONS,
    cardFormats: CARD_FORMATS,
    caveats: AKUVOX_CAVEATS,
    docs: AKUVOX_PROFILE.docs,
    unsynced: store.listUnsyncedCards().length,
    lastSync: lastSyncReport,
  };
}

// --- automatyczne dosyłanie zaległych ---------------------------------------

let syncTimer = null;
let syncing = false;
let lastSyncReport = null;

/**
 * Na budowie łączność wraca i znika. Zamiast kazać instalatorowi pamiętać
 * o przycisku, próbujemy dosłać zaległe w tle — ale tylko gdy jest co dosyłać
 * i gdy nie jest włączony tryb offline.
 */
async function syncTick() {
  if (syncing) return;
  const s = store.getSettings();
  if (!s.autoSync || s.offlineQueue) return;
  if (!store.listUnsyncedCards().length) return;
  const conn = activeConnection();
  if (!conn || !connectionState(conn).configured) return;

  syncing = true;
  try {
    const report = await integration.retryPending({ installerName: s.installerName });
    lastSyncReport = { at: new Date().toISOString(), ...report, results: undefined };
    mainWindow?.webContents.send('akuvox:sync', lastSyncReport);
  } catch (err) {
    lastSyncReport = { at: new Date().toISOString(), total: 0, ok: 0, error: err.message };
  } finally {
    syncing = false;
  }
}

function startAutoSync() {
  if (syncTimer) return;
  // Minuta to kompromis: dość szybko po powrocie sieci, a przy braku łączności
  // nie zasypuje dziennika próbami.
  syncTimer = setInterval(() => void syncTick(), 60_000);
}

/** Przenosi sekrety z jednej globalnej konfiguracji na połączenie. */
function migrateSecrets() {
  const id = store.migratedConnectionId;
  if (!id) return;
  for (const [oldKey, field] of [['akuvoxClientSecret', 'clientSecret'], ['akuvoxPassword', 'password']]) {
    const value = secrets.get(oldKey);
    if (value && !secrets.has(secretKey(id, field))) {
      secrets.set(secretKey(id, field), value);
      secrets.set(oldKey, '');
    }
  }
}

async function saveHandover(kind, options = {}) {
  const conn = activeConnection();
  const rows = handoverRows(store, {
    connectionId: options.connectionId ?? conn?.id ?? '',
    siteId: options.siteId || '',
    cardFormat: conn?.cardFormat || 'dec',
  });
  if (!rows.length) return { ok: false, empty: true };

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = `protokol-przekazania-${stamp}.${kind === 'pdf' ? 'pdf' : 'csv'}`;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Protokół przekazania kart',
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: kind === 'pdf' ? 'PDF' : 'CSV', extensions: [kind === 'pdf' ? 'pdf' : 'csv'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  if (kind === 'csv') {
    fs.writeFileSync(filePath, '\ufeff' + handoverCsv(store, {
      connectionId: options.connectionId ?? conn?.id ?? '',
      siteId: options.siteId || '',
      cardFormat: conn?.cardFormat || 'dec',
    }), 'utf8');
    return { ok: true, filePath, rows: rows.length };
  }

  const pdf = await renderHandoverPdf(rows, conn);
  fs.writeFileSync(filePath, pdf);
  return { ok: true, filePath, rows: rows.length };
}

/**
 * PDF składamy Chromiumem wbudowanym w Electrona (printToPDF) — bez biblioteki
 * do generowania dokumentów. Protokół jest do podpisania, więc ma miejsca na
 * podpisy i datę.
 */
async function renderHandoverPdf(rows, conn) {
  const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const settings = store.getSettings();
  const today = new Date().toLocaleDateString('pl-PL');

  const html = `<!doctype html><meta charset="utf-8"><style>
    body { font: 11px/1.45 -apple-system, system-ui, sans-serif; color: #111; margin: 24px; }
    h1 { font-size: 17px; margin: 0 0 4px; }
    .meta { color: #555; font-size: 10.5px; margin-bottom: 14px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #bbb; padding: 5px 6px; text-align: left; vertical-align: top; }
    th { background: #eee; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
    td.mono { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; }
    .signatures { margin-top: 34px; display: flex; gap: 40px; }
    .signatures div { flex: 1; border-top: 1px solid #333; padding-top: 5px; font-size: 10px; color: #444; }
  </style>
  <h1>Protokół przekazania kart zbliżeniowych</h1>
  <div class="meta">
    Obiekt: <strong>${esc(rows[0]?.obiekt || '—')}</strong> ·
    Połączenie: ${esc(conn?.name || '—')} ·
    Kart: <strong>${rows.length}</strong> ·
    Data: ${esc(today)}${settings.installerName ? ` · Wydał: <strong>${esc(settings.installerName)}</strong>` : ''}
  </div>
  <table>
    <thead><tr>
      <th>Mieszkanie</th><th>Mieszkaniec</th><th>Karta</th><th>UID</th><th>Numer</th><th>Stan</th><th>Uwagi</th>
    </tr></thead>
    <tbody>
      ${rows.map((r) => `<tr>
        <td>${esc(r.mieszkanie)}</td><td>${esc(r.mieszkaniec)}</td><td>${esc(r.karta)}</td>
        <td class="mono">${esc(r.uid)}</td><td class="mono">${esc(r.numer)}</td>
        <td>${esc(r.stan)}</td><td>${esc(r.uwagi)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <div class="signatures">
    <div>Wydał (instalator)${settings.installerName ? `: ${esc(settings.installerName)}` : ''}</div>
    <div>Odebrał (zarządca / właściciel)</div>
  </div>`;

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', landscape: rows.length > 0 });
  } finally {
    win.destroy();
  }
}

function distDir() {
  return path.join(__dirname, '..', 'dist');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'RFID Scanner',
    backgroundColor: '#0f1420',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (useDevServer) {
    mainWindow.loadURL(DEV_URL);
  } else {
    const bundle = path.join(__dirname, '..', 'dist', 'index.html');
    if (!fs.existsSync(bundle)) {
      dialog.showErrorBox(
        'Brak zbudowanego interfejsu',
        'Nie znaleziono katalogu dist/. Uruchom „npm run build” (albo „npm start”, który buduje i startuje aplikację).',
      );
      app.quit();
      return;
    }
    mainWindow.loadFile(bundle);
  }

  // Linki zewnętrzne otwieramy w przeglądarce, nie w oknie aplikacji.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Plik',
      submenu: [
        {
          label: 'Eksport kart do CSV…',
          click: () => exportCsv('cards'),
        },
        {
          label: 'Eksport historii do CSV…',
          click: () => exportCsv('scans'),
        },
        { type: 'separator' },
        {
          label: 'Pokaż plik bazy danych',
          click: () => shell.showItemInFolder(store.file),
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Widok',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function exportCsv(kind) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const suggested = kind === 'cards' ? `karty-${stamp}.csv` : `historia-${stamp}.csv`;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: kind === 'cards' ? 'Eksport kart' : 'Eksport historii odczytów',
    defaultPath: path.join(app.getPath('downloads'), suggested),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const csv = kind === 'cards' ? store.cardsCsv() : store.scansCsv();
  // BOM, żeby Excel poprawnie odczytał polskie znaki.
  fs.writeFileSync(filePath, '﻿' + csv, 'utf8');
  return { ok: true, filePath };
}

/** Owija handler IPC tak, by błąd wrócił jako wynik, a nie wyjątek w renderze. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), code: err?.code };
    }
  });
}

function registerIpc() {
  // Serwer telefonu. Odczyty z telefonu przechodzą tę samą logikę co odczyty
  // z czytnika USB, a wynik trafia do okna, żeby panel odczytu pokazał go
  // tak samo jak kartę zbliżoną do czytnika.
  handle('bridge:status', () => bridge.status());
  handle('bridge:start', async () => {
    store.setSettings({ bridgeEnabled: true });
    return bridge.start();
  });
  handle('bridge:stop', async () => {
    store.setSettings({ bridgeEnabled: false });
    return bridge.stop();
  });
  handle('bridge:restart', async ({ port } = {}) => {
    if (port) store.setSettings({ bridgePort: port });
    await bridge.stop();
    return bridge.start();
  });
  handle('bridge:regenerate-token', async () => {
    // Nowy sekret unieważnia wcześniejsze parowania — trzeba zeskanować
    // kod QR na nowo.
    bridge.regenerateToken();
    if (bridge.status().running) {
      await bridge.stop();
      return bridge.start();
    }
    return bridge.status();
  });

  // Odczyt karty — jedyny kanał wywoływany w gorącej ścieżce.
  ipcMain.handle('scan:process', (_e, { raw, station } = {}) => service.processScan(raw, { station }));
  ipcMain.handle('scan:inspect', (_e, { raw } = {}) => service.inspect(raw));

  handle('cards:list', (query) => store.listCards(query || {}));
  handle('cards:get', ({ id }) => store.getCard(id));
  handle('cards:create', (input) => service.enroll(input));
  handle('cards:update', ({ id, patch }) => store.updateCard(id, patch));
  handle('cards:delete', ({ id }) => store.deleteCard(id));

  handle('scans:list', (query) => store.listScans(query || {}));
  handle('scans:clear', () => {
    store.data.scans = [];
    store.save();
    return true;
  });

  // --- integracja z chmurą Akuvox -----------------------------------------
  handle('akuvox:status', () => akuvoxStatus());
  handle('akuvox:save-connection', (input = {}) => {
    const { clientSecret, password, ...rest } = input;
    const conn = store.saveConnection(rest);
    // Sekrety idą do magazynu szyfrowanego systemowo, nie do pliku z kartami.
    if (clientSecret) secrets.set(secretKey(conn.id, 'clientSecret'), clientSecret);
    if (password) secrets.set(secretKey(conn.id, 'password'), password);
    adapterCache = null;
    return akuvoxStatus();
  });
  handle('akuvox:delete-connection', ({ id }) => {
    const result = store.deleteConnection(id);
    secrets.set(secretKey(id, 'clientSecret'), '');
    secrets.set(secretKey(id, 'password'), '');
    adapterCache = null;
    return { ...result, status: akuvoxStatus() };
  });
  handle('akuvox:activate-connection', ({ id }) => {
    store.setActiveConnection(id);
    adapterCache = null;
    return akuvoxStatus();
  });
  handle('akuvox:save-options', (patch = {}) => {
    store.setSettings(patch);
    return akuvoxStatus();
  });
  handle('akuvox:test', () => integration.test());
  handle('akuvox:check', ({ cardId, target }) => integration.checkAssign(cardId, target));
  handle('akuvox:verify', ({ cardId }) => integration.verify(cardId));
  handle('akuvox:replace', ({ oldCardId, newCardId, reason }) => integration.replaceCard(oldCardId, newCardId, reason, {
    connectionId: activeConnection()?.id,
    installerName: store.getSettings().installerName,
  }));
  handle('akuvox:handover', ({ kind, siteId }) => saveHandover(kind, { siteId }));
  handle('akuvox:sites', () => integration.sites());
  handle('akuvox:apartments', ({ siteId }) => integration.apartments(siteId));
  handle('akuvox:residents', ({ siteId, apartmentId }) => integration.residents(siteId, apartmentId));
  handle('akuvox:resident-cards', (target) => integration.residentCards(target));
  handle('akuvox:assign', ({ cardId, target }) => {
    const s = store.getSettings();
    return integration.assign(cardId, target, {
      connectionId: activeConnection()?.id,
      installerName: s.installerName,
      offline: s.offlineQueue,
    });
  });
  handle('akuvox:unassign', ({ cardId }) => integration.unassign(cardId));
  handle('akuvox:retry', () => integration.retryPending({ installerName: store.getSettings().installerName }));
  handle('akuvox:log', () => (integrationHttp ? integrationHttp.recentLog() : []));

  handle('stats:get', () => store.stats());
  handle('settings:get', () => store.getSettings());
  handle('settings:set', (patch) => store.setSettings(patch || {}));

  handle('export:csv', ({ kind }) => exportCsv(kind));
  handle('reader:detect', () => detectReaders());
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    dataFile: store.file,
    isDev,
  }));
}

/**
 * Polityka bezpieczeństwa treści. Nakładamy ją tylko na wersję spakowaną —
 * serwer deweloperski Vite wstrzykuje inline'owy skrypt React Refresh,
 * którego `script-src 'self'` by zablokował.
 */
function applyContentSecurityPolicy() {
  if (useDevServer) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        ],
      },
    });
  });
}

// Jedna instancja — dwie kopie pisałyby do tego samego pliku bazy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    applyContentSecurityPolicy();
    store = new Store(fileAdapter(dataFile()));
    service = new ScanService(store);
    secrets = new SecretStore(path.join(path.dirname(dataFile()), 'rfid-secrets.bin'));
    migrateSecrets();
    integration = new IntegrationService({ store, adapter: () => akuvoxAdapter() });
    startAutoSync();
    bridge = new PhoneBridge({
      store,
      service,
      distDir: distDir(),
      onScan: (result) => mainWindow?.webContents.send('bridge:scan', result),
    });
    registerIpc();
    buildMenu();
    createWindow();

    // Serwer wraca do stanu z poprzedniej sesji, żeby po ponownym
    // uruchomieniu telefon nie wymagał parowania od nowa.
    if (store.getSettings().bridgeEnabled) {
      bridge.start().then((status) => {
        if (status.error) console.error(`Serwer telefonu: ${status.error}`);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // Zapis jest odroczony — przed wyjściem wymuszamy zrzut na dysk.
    try { store?.flush(); } catch { /* ignorujemy */ }
    try { void bridge?.stop(); } catch { /* ignorujemy */ }
    if (syncTimer) clearInterval(syncTimer);
  });
}
