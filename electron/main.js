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
import { IntegrationService } from '../shared/integration.js';
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
 * Adapter chmury budowany na bieżąco z ustawień i sekretów.
 *
 * Tworzony przy każdym wywołaniu, ale token żyje w instancji — dlatego
 * trzymamy jedną i przebudowujemy ją tylko po zmianie konfiguracji.
 * Inaczej każda operacja logowałaby się od nowa.
 */
let adapterCache = null;
let adapterKey = '';

function akuvoxAdapter() {
  const s = store.getSettings();
  const profile = {
    ...AKUVOX_PROFILE,
    providerId: 'akuvox',
    baseUrl: s.akuvoxBaseUrl || AKUVOX_PROFILE.baseUrl,
    cardFormat: s.akuvoxCardFormat,
  };
  const credentials = {
    clientId: s.akuvoxClientId,
    clientSecret: secrets.get('akuvoxClientSecret'),
    username: s.akuvoxUsername,
    password: secrets.get('akuvoxPassword'),
  };
  // Zmiana czegokolwiek istotnego unieważnia token — stąd klucz z konfiguracji.
  const key = JSON.stringify([profile.baseUrl, profile.cardFormat, credentials.clientId, credentials.username, Boolean(credentials.clientSecret), Boolean(credentials.password), s.akuvoxDryRun]);
  if (adapterCache && adapterKey === key) return adapterCache;

  integrationHttp = new HttpClient({ retries: 2, timeoutMs: 15_000, dryRun: s.akuvoxDryRun, logSize: 60 });
  adapterCache = new RestAdapter({ profile, credentials, http: integrationHttp });
  adapterKey = key;
  return adapterCache;
}

function akuvoxStatus() {
  const s = store.getSettings();
  const missing = [];
  if (!s.akuvoxBaseUrl) missing.push('adres serwera');
  if (!s.akuvoxClientId) missing.push('client_id');
  if (!secrets.has('akuvoxClientSecret')) missing.push('client_secret');
  if (!s.akuvoxUsername) missing.push('login zarządcy');
  if (!secrets.has('akuvoxPassword')) missing.push('hasło zarządcy');

  return {
    enabled: s.akuvoxEnabled,
    baseUrl: s.akuvoxBaseUrl,
    region: s.akuvoxRegion,
    cardFormat: s.akuvoxCardFormat,
    clientId: s.akuvoxClientId,
    username: s.akuvoxUsername,
    dryRun: s.akuvoxDryRun,
    hasClientSecret: secrets.has('akuvoxClientSecret'),
    hasPassword: secrets.has('akuvoxPassword'),
    secretStorageAvailable: secrets.available,
    configured: missing.length === 0,
    missing,
    regions: AKUVOX_REGIONS,
    cardFormats: CARD_FORMATS,
    caveats: AKUVOX_CAVEATS,
    docs: AKUVOX_PROFILE.docs,
    unsynced: store.listUnsyncedCards().length,
  };
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
  handle('akuvox:save', (patch = {}) => {
    const { clientSecret, password, ...rest } = patch;
    // Sekrety idą do magazynu szyfrowanego systemowo, nie do pliku z kartami.
    if (clientSecret !== undefined) secrets.set('akuvoxClientSecret', clientSecret);
    if (password !== undefined) secrets.set('akuvoxPassword', password);
    store.setSettings(rest);
    adapterCache = null;
    return akuvoxStatus();
  });
  handle('akuvox:test', () => integration.test());
  handle('akuvox:sites', () => integration.sites());
  handle('akuvox:apartments', ({ siteId }) => integration.apartments(siteId));
  handle('akuvox:residents', ({ siteId, apartmentId }) => integration.residents(siteId, apartmentId));
  handle('akuvox:resident-cards', (target) => integration.residentCards(target));
  handle('akuvox:assign', ({ cardId, target }) => integration.assign(cardId, target));
  handle('akuvox:unassign', ({ cardId }) => integration.unassign(cardId));
  handle('akuvox:retry', () => integration.retryPending());
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
    integration = new IntegrationService({ store, adapter: () => akuvoxAdapter() });
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
  });
}
