/**
 * Serwer HTTP udostępniający telefon jako skaner.
 *
 * Po włączeniu aplikacja pokazuje kod QR z adresem w sieci lokalnej. Telefon
 * po zeskanowaniu tego kodu otwiera lekką stronę skanera i wysyła odczyty do
 * aplikacji, gdzie przechodzą przez te same reguły dostępu co odczyty z
 * czytnika USB.
 *
 * Czego telefon NIE potrafi: iPhone nie odczyta karty RFID ze strony
 * internetowej — Safari nie ma Web NFC (to API istnieje tylko w Chrome na
 * Androidzie). Telefon skanuje więc kody QR i kreskowe kamerą albo służy do
 * wpisania numeru z etykiety. Do odczytu samych kart zbliżeniowych nadal
 * potrzebny jest czytnik USB.
 *
 * Bezpieczeństwo: serwer jest domyślnie wyłączony, a po włączeniu wymaga
 * sekretu z adresu sparowania. Kto ma kod QR, ma dostęp — dlatego sekret można
 * w każdej chwili wygenerować od nowa, co unieważnia wcześniejsze parowania.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_BODY = 4096;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

/** Adresy IPv4 tej maszyny w sieci lokalnej. */
export function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      out.push({ name, address: iface.address });
    }
  }
  return out;
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** Porównanie odporne na atak czasowy — długości muszą być równe. */
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  if (given.length !== expected.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export class PhoneBridge {
  /**
   * @param {object} deps
   * @param {import('../shared/store.js').Store} deps.store
   * @param {object} deps.service   ScanService
   * @param {string} deps.distDir   katalog ze zbudowanym interfejsem (mobile.html + assets)
   * @param {(result: object) => void} [deps.onScan] wywoływane po odczycie z telefonu
   */
  constructor({ store, service, distDir, onScan }) {
    this.store = store;
    this.service = service;
    this.distDir = distDir;
    this.onScan = onScan || (() => {});
    this.server = null;
    this.port = null;
    this.error = null;
    this.hits = new Map();
  }

  get token() {
    let token = this.store.getSettings().bridgeToken;
    if (!token) {
      token = newToken();
      this.store.setSettings({ bridgeToken: token });
    }
    return token;
  }

  regenerateToken() {
    this.store.setSettings({ bridgeToken: newToken() });
    return this.status();
  }

  status() {
    const settings = this.store.getSettings();
    const running = Boolean(this.server?.listening);
    const port = this.port || settings.bridgePort;
    const addresses = localAddresses();
    return {
      running,
      enabled: settings.bridgeEnabled,
      port,
      token: running ? this.token : '',
      error: this.error,
      addresses,
      urls: running ? addresses.map((a) => `http://${a.address}:${port}/s/${this.token}`) : [],
    };
  }

  start() {
    if (this.server) return Promise.resolve(this.status());
    const port = this.store.getSettings().bridgePort;
    this.error = null;

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.#handle(req, res));

      server.on('error', (err) => {
        this.error = err.code === 'EADDRINUSE'
          ? `Port ${port} jest zajęty przez inny program — wybierz inny.`
          : err.message;
        this.server = null;
        this.port = null;
        resolve(this.status());
      });

      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        this.port = port;
        // Sekret powstaje przy pierwszym starcie, nie przy zapisie ustawień.
        void this.token;
        resolve(this.status());
      });
    });
  }

  stop() {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.hits.clear();
    if (!server) return Promise.resolve(this.status());
    return new Promise((resolve) => {
      server.close(() => resolve(this.status()));
      // Trwające połączenia (np. otwarta strona telefonu) nie mogą blokować zamknięcia.
      server.closeAllConnections?.();
    });
  }

  /** Limit zapytań na adres IP — chroni przed zgadywaniem sekretu. */
  #rateLimited(ip) {
    const now = Date.now();
    const times = (this.hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    times.push(now);
    this.hits.set(ip, times);
    if (this.hits.size > 256) {
      for (const [key, list] of this.hits) {
        if (!list.some((t) => now - t < RATE_WINDOW_MS)) this.hits.delete(key);
      }
    }
    return times.length > RATE_MAX;
  }

  /**
   * Ochrona przed DNS rebinding: żądanie musi trafić na adres tej maszyny,
   * a nie na nazwę domenową wskazującą na jej IP.
   */
  #hostAllowed(hostHeader) {
    if (!hostHeader) return false;
    const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    return localAddresses().some((a) => a.address === host);
  }

  async #handle(req, res) {
    const ip = req.socket.remoteAddress || 'nieznany';
    try {
      if (!this.#hostAllowed(req.headers.host)) return this.#send(res, 400, 'Nieprawidłowy adres.');
      if (this.#rateLimited(ip)) return this.#send(res, 429, 'Zbyt wiele zapytań.');

      const url = new URL(req.url, `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean);

      // Zasoby zbudowanego interfejsu: /assets/... albo /s/<token>/assets/...
      const assetIndex = parts.indexOf('assets');
      if (assetIndex !== -1 && parts.length === assetIndex + 2) {
        return this.#sendAsset(res, parts[assetIndex + 1]);
      }

      // Strona skanera: /s/<token>
      if (parts[0] === 's') {
        if (!tokenMatches(parts[1] || '', this.token)) return this.#send(res, 401, 'Nieaktualny kod parowania. Zeskanuj kod QR ponownie.');
        const rest = parts.slice(2);
        if (rest.length === 0) return this.#sendPage(res);
        if (rest[0] === 'api' && rest[1] === 'scan' && req.method === 'POST') return this.#apiScan(req, res);
        if (rest[0] === 'api' && rest[1] === 'recent') return this.#apiRecent(res);
        return this.#send(res, 404, 'Nie znaleziono.');
      }

      // Odczyt bezpośrednio z aplikacji Kamera: /q/<token>/<numer>
      if (parts[0] === 'q') {
        if (!tokenMatches(parts[1] || '', this.token)) return this.#send(res, 401, 'Nieaktualny kod parowania.');
        return this.#quickScan(res, decodeURIComponent(parts.slice(2).join('/')));
      }

      return this.#send(res, 404, 'Nie znaleziono. Zeskanuj kod QR z aplikacji.');
    } catch (err) {
      return this.#send(res, 500, `Błąd serwera: ${err.message}`);
    }
  }

  #headers(extra = {}) {
    return {
      // Strona telefonu ładuje wyłącznie własne zasoby.
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...extra,
    };
  }

  #send(res, code, text) {
    res.writeHead(code, this.#headers({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end(text);
  }

  #sendJson(res, code, data) {
    res.writeHead(code, this.#headers({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify(data));
  }

  #sendAsset(res, name) {
    // Tylko proste nazwy plików — bez przechodzenia po katalogach.
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
      return this.#send(res, 400, 'Nieprawidłowa nazwa pliku.');
    }
    const file = path.join(this.distDir, 'assets', name);
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      return this.#send(res, 404, 'Nie znaleziono zasobu.');
    }
    const type = CONTENT_TYPES[path.extname(name)] || 'application/octet-stream';
    res.writeHead(200, this.#headers({ 'Content-Type': type }));
    res.end(data);
  }

  #sendPage(res) {
    const file = path.join(this.distDir, 'mobile.html');
    let html;
    try {
      html = fs.readFileSync(file, 'utf8');
    } catch {
      return this.#send(res, 500, 'Brak zbudowanej strony skanera. Uruchom „npm run build”.');
    }
    res.writeHead(200, this.#headers({ 'Content-Type': CONTENT_TYPES['.html'] }));
    res.end(html);
  }

  #readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('Treść zapytania zbyt duża.'), { code: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /** Odczyt przechodzi dokładnie te same reguły co odczyt z czytnika USB. */
  #register(raw, source) {
    const station = `${this.store.getSettings().station}/${source}`;
    const result = this.service.processScan(raw, { station });
    if (result.ok) this.onScan(result);
    return result;
  }

  async #apiScan(req, res) {
    let payload;
    try {
      payload = JSON.parse((await this.#readBody(req)) || '{}');
    } catch (err) {
      return this.#sendJson(res, err.code === 413 ? 413 : 400, { ok: false, error: 'Nieprawidłowe dane zapytania.' });
    }
    const raw = typeof payload.raw === 'string' ? payload.raw : '';
    if (!raw.trim()) return this.#sendJson(res, 400, { ok: false, error: 'Puste odczytanie.' });
    const source = payload.source === 'kamera' ? 'kamera' : 'telefon';
    return this.#sendJson(res, 200, this.#register(raw, source));
  }

  #apiRecent(res) {
    const { rows } = this.store.listScans({ limit: 8 });
    return this.#sendJson(res, 200, {
      ok: true,
      rows: rows.map((s) => ({
        ts: s.ts,
        uidHex: s.uidHex,
        decision: s.decision,
        label: s.cardLabel || '',
        station: s.station,
      })),
    });
  }

  /**
   * Wejście dla aplikacji Kamera w iOS: kod QR karty zawiera adres
   * /q/<token>/<numer>, więc zeskanowanie kodu systemową kamerą od razu
   * rejestruje odczyt i pokazuje wynik na telefonie.
   */
  #quickScan(res, raw) {
    const result = this.#register(raw, 'kamera');
    const decision = result.ok ? result.decision : 'error';
    const titles = {
      granted: 'Dostęp przyznany',
      denied: 'Dostęp odmówiony',
      unknown: 'Karta nieznana',
      duplicate: 'Powtórny odczyt',
      error: 'Nie rozpoznano',
    };
    const colors = {
      granted: '#35d07f',
      denied: '#ff5d6c',
      unknown: '#ffb339',
      duplicate: '#98a4bd',
      error: '#ff5d6c',
    };
    const detail = result.ok
      ? `${result.card ? (result.card.label || 'Karta bez nazwy') : 'Karta nie jest w bazie'} — ${result.reason}`
      : result.error;
    const uid = result.ok ? result.uid.pretty : String(raw).slice(0, 40);
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

    res.writeHead(200, this.#headers({ 'Content-Type': CONTENT_TYPES['.html'] }));
    res.end(`<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titles[decision])}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0f1420;
         color:#e8edf7; font:16px/1.5 -apple-system, system-ui, sans-serif; text-align:center; padding:24px; }
  .badge { font-size:26px; font-weight:700; color:${colors[decision]}; margin-bottom:12px; }
  code { display:block; margin-top:14px; color:#98a4bd; font-size:15px; }
  a { display:inline-block; margin-top:26px; color:#4c8dff; }
</style></head><body><div>
  <div class="badge">${esc(titles[decision])}</div>
  <div>${esc(detail)}</div>
  <code>${esc(uid)}</code>
  <a href="/s/${this.token}">Otwórz skaner</a>
</div></body></html>`);
  }
}
