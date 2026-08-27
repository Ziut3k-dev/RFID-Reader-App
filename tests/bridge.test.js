import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../shared/store.js';
import { ScanService } from '../shared/service.js';
import { PhoneBridge } from '../electron/bridge.js';

/** Katalog udający zbudowany interfejs — testy nie zależą od `npm run build`. */
function fakeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfid-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'mobile.html'), '<!doctype html><title>Skaner</title>');
  fs.writeFileSync(path.join(dir, 'assets', 'mobile.js'), 'console.log("skaner")');
  return dir;
}

function memoryAdapter() {
  let text = null;
  return { label: 'memory', read: () => text, write: (v) => { text = v; }, quarantine: () => { text = null; } };
}

/** Uruchamia serwer na losowym wysokim porcie i zwraca pomocniki do zapytań. */
async function startBridge(settings = {}) {
  const store = new Store(memoryAdapter());
  const port = 20000 + Math.floor(Math.random() * 20000);
  store.setSettings({ debounceSeconds: 0, bridgePort: port, ...settings });
  const service = new ScanService(store);
  const scans = [];
  const dist = fakeDist();
  const bridge = new PhoneBridge({ store, service, distDir: dist, onScan: (r) => scans.push(r) });

  const status = await bridge.start();
  assert.equal(status.running, true, `serwer nie wystartował: ${status.error}`);

  const base = `http://127.0.0.1:${status.port}`;
  return {
    store,
    service,
    bridge,
    scans,
    token: status.token,
    url: (p) => `${base}${p}`,
    get: (p, init) => fetch(`${base}${p}`, init),
    post: (p, body) => fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    async close() {
      await bridge.stop();
      fs.rmSync(dist, { recursive: true, force: true });
    },
  };
}

test('serwer startuje, zwraca stan i zatrzymuje się', async () => {
  const b = await startBridge();
  const status = b.bridge.status();
  assert.equal(status.running, true);
  assert.match(status.token, /^[0-9a-f]{32}$/);
  assert.ok(status.urls.every((u) => u.includes(status.token)));

  await b.bridge.stop();
  assert.equal(b.bridge.status().running, false);
  assert.equal(b.bridge.status().token, '', 'zatrzymany serwer nie ujawnia sekretu');
  await b.close();
});

test('strona skanera wymaga poprawnego sekretu', async () => {
  const b = await startBridge();

  const ok = await b.get(`/s/${b.token}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Skaner/);

  for (const bad of ['', 'zly', '0'.repeat(32)]) {
    const res = await b.get(`/s/${bad}`);
    assert.equal(res.status, 401, `sekret "${bad}" nie powinien być przyjęty`);
  }
  await b.close();
});

test('odczyt z telefonu przechodzi reguły dostępu i trafia do historii', async () => {
  const b = await startBridge();
  b.service.enroll({ uid: '0004372425', label: 'Karta 1', owner: 'Anna' });

  const res = await b.post(`/s/${b.token}/api/scan`, { raw: '0004372425', source: 'kamera' });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.decision, 'granted');
  assert.equal(data.card.label, 'Karta 1');
  assert.equal(b.store.listScans().total, 1);
  assert.equal(b.store.listScans().rows[0].station, 'default/kamera', 'historia ma pokazywać źródło odczytu');
  assert.equal(b.scans.length, 1, 'okno aplikacji ma dostać powiadomienie o odczycie');
  await b.close();
});

test('nieznana karta z telefonu daje odmowę, nie błąd', async () => {
  const b = await startBridge();
  const data = await (await b.post(`/s/${b.token}/api/scan`, { raw: '0004372425' })).json();
  assert.equal(data.ok, true);
  assert.equal(data.decision, 'unknown');
  await b.close();
});

test('puste i nieprawidłowe zapytania są odrzucane', async () => {
  const b = await startBridge();
  assert.equal((await b.post(`/s/${b.token}/api/scan`, { raw: '   ' })).status, 400);
  assert.equal((await b.post(`/s/${b.token}/api/scan`, 'to nie jest JSON')).status, 400);

  // Odczyt nie do zinterpretowania nie jest błędem HTTP — telefon ma pokazać powód.
  const bad = await (await b.post(`/s/${b.token}/api/scan`, { raw: '!!!' })).json();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /nieprawid/i);
  await b.close();
});

test('zbyt duża treść zapytania jest ucinana', async () => {
  const b = await startBridge();
  const res = await b.post(`/s/${b.token}/api/scan`, JSON.stringify({ raw: 'A'.repeat(8000) }))
    .catch((err) => ({ status: 0, err }));
  // Serwer zamyka połączenie albo odpowiada 413 — obie drogi są poprawne.
  assert.ok(res.status === 413 || res.status === 0 || res.status === 400, `nieoczekiwany status ${res.status}`);
  assert.equal(b.store.listScans().total, 0, 'przerwane zapytanie nie może zapisać odczytu');
  await b.close();
});

test('skanowanie kodu systemową kamerą rejestruje odczyt i pokazuje wynik', async () => {
  const b = await startBridge();
  b.service.enroll({ uid: '0004372425', label: 'Magazyn' });

  const res = await b.get(`/q/${b.token}/0004372425`);
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /Dostęp przyznany/);
  assert.match(html, /Magazyn/);
  assert.match(html, /00:42:B7:C9/);
  assert.equal(b.store.listScans().total, 1);

  assert.equal((await b.get('/q/zlytoken/0004372425')).status, 401);
  await b.close();
});

test('zasoby interfejsu są serwowane, przechodzenie po katalogach zablokowane', async () => {
  const b = await startBridge();
  assert.equal((await b.get(`/s/${b.token}/assets/mobile.js`)).status, 200);
  assert.equal((await b.get('/assets/mobile.js')).status, 200);
  assert.equal((await b.get('/assets/nie-ma.js')).status, 404);

  for (const bad of ['/assets/..%2F..%2Fpackage.json', '/assets/%2Fetc%2Fpasswd']) {
    const res = await b.get(bad);
    assert.ok(res.status === 400 || res.status === 404, `${bad} zwróciło ${res.status}`);
  }
  await b.close();
});

test('żądanie z podstawioną nazwą hosta jest odrzucane (DNS rebinding)', async () => {
  const b = await startBridge();
  const port = b.bridge.status().port;

  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/s/${b.token}`, headers: { Host: 'zlosliwa-strona.example' } },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on('error', reject);
    req.end();
  });

  assert.equal(status, 400);
  await b.close();
});

test('nowy sekret unieważnia poprzednie parowanie', async () => {
  const b = await startBridge();
  const old = b.token;
  b.bridge.regenerateToken();
  const fresh = b.bridge.status().token;

  assert.notEqual(fresh, old);
  assert.equal((await b.get(`/s/${old}`)).status, 401);
  assert.equal((await b.get(`/s/${fresh}`)).status, 200);
  await b.close();
});

test('limit zapytań chroni przed zgadywaniem sekretu', async () => {
  const b = await startBridge();
  let limited = false;
  for (let i = 0; i < 260; i += 1) {
    const res = await b.get(`/s/${'a'.repeat(32)}`);
    if (res.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'po serii zapytań serwer powinien odpowiedzieć 429');
  await b.close();
});
