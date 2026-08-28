import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HttpClient, HttpError, isSecretField, redactBody, redactHeaders } from '../electron/http-client.js';

/** Serwer testowy zwracający to, co scenariusz każe. */
async function server(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  return { url: (p = '/') => `http://127.0.0.1:${port}${p}`, close: () => new Promise((r) => srv.close(r)) };
}

test('maskowanie sekretów w nagłówkach i treści', () => {
  const headers = redactHeaders({ Authorization: 'Bearer abcdef1234567890', Accept: 'application/json' });
  assert.match(headers.Authorization, /^Bear…90 \(\d+ znaków\)$/);
  assert.equal(headers.Accept, 'application/json');

  const body = redactBody({ appKey: 'k', apiSecret: 'bardzo-tajne-haslo', nested: { token: 'xyz123456789', name: 'Anna' } });
  assert.equal(body.apiSecret.includes('bardzo-tajne-haslo'), false);
  assert.equal(body.nested.name, 'Anna');
  assert.equal(body.nested.token.includes('xyz123456789'), false);
  // Krótkie sekrety maskujemy w całości, żeby nie ujawnić ich długości ani treści.
  assert.equal(body.appKey, '***');
});

test('rozpoznawanie pól z sekretami po fragmencie nazwy', () => {
  // Warianty, na które nabrałaby się lista dokładnych nazw.
  for (const name of [
    'password', 'apiSecret', 'clientSecret', 'app_secret', 'accessKeyId', 'privateKey',
    'X-Auth-Token', 'refresh_token', 'credentials', 'signature', 'Authorization', 'pin', 'key',
  ]) {
    assert.equal(isSecretField(name), true, `${name} powinno być maskowane`);
  }
  // Pola, których maskowanie zabrałoby wartość diagnostyczną.
  for (const name of ['assignee', 'keyboard', 'residentName', 'apartmentId', 'cardNumber', 'signedAt']) {
    assert.equal(isSecretField(name), false, `${name} nie powinno być maskowane`);
  }
});

test('udane zapytanie zwraca dane i trafia do dziennika', async () => {
  const s = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, items: [1, 2] }));
  });
  const client = new HttpClient({ retries: 0 });
  const { status, data } = await client.request(s.url('/lista'));

  assert.equal(status, 200);
  assert.deepEqual(data.items, [1, 2]);
  assert.equal(client.recentLog()[0].status, 200);
  assert.equal(client.recentLog()[0].attempts, 1);
  await s.close();
});

test('błąd przejściowy jest ponawiany, trwały nie', async () => {
  let hits = 0;
  const s = await server((req, res) => {
    hits += 1;
    if (req.url === '/chwilowy') {
      // Dwa razy 503, potem sukces.
      if (hits < 3) { res.writeHead(503); res.end('chwilowo niedostępny'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(401);
    res.end('brak dostępu');
  });

  const client = new HttpClient({ retries: 2 });
  const res = await client.request(s.url('/chwilowy'));
  assert.equal(res.status, 200);
  assert.equal(hits, 3, 'powinny być dwa ponowienia');

  hits = 0;
  await assert.rejects(
    () => client.request(s.url('/brak-dostepu')),
    (err) => err instanceof HttpError && err.status === 401,
  );
  assert.equal(hits, 1, '401 nie ma być ponawiane — ponowienie nie naprawi braku uprawnień');
  await s.close();
});

test('limit czasu przerywa zapytanie', async () => {
  const s = await server(() => { /* celowo bez odpowiedzi */ });
  const client = new HttpClient({ timeoutMs: 300, retries: 0 });

  await assert.rejects(
    () => client.request(s.url('/wisi')),
    (err) => err instanceof HttpError && /limit czasu/.test(err.message),
  );
  await s.close();
});

test('tryb podglądu nie wysyła zapytania, ale je zapisuje', async () => {
  let hits = 0;
  const s = await server((req, res) => { hits += 1; res.writeHead(200); res.end('{}'); });
  const client = new HttpClient({ dryRun: true });

  const res = await client.request(s.url('/przypisz'), { method: 'POST', body: { card: '0042B7C9' } });
  assert.equal(res.dryRun, true);
  assert.equal(hits, 0, 'w trybie podglądu nic nie leci na drut');
  assert.equal(client.recentLog()[0].method, 'POST');
  assert.equal(client.recentLog()[0].body.card, '0042B7C9');
  await s.close();
});

test('dziennik ma ograniczony rozmiar', async () => {
  const s = await server((req, res) => { res.writeHead(200); res.end('{}'); });
  const client = new HttpClient({ logSize: 3, retries: 0 });
  for (let i = 0; i < 6; i += 1) await client.request(s.url(`/${i}`));

  assert.equal(client.recentLog().length, 3);
  assert.match(client.recentLog()[0].url, /\/5$/, 'najnowsze zapytanie na początku');
  await s.close();
});

test('treść formularza leci bez zmian, a sekrety w niej są maskowane w dzienniku', async () => {
  let seen = null;
  const s = await server((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { body, contentType: req.headers['content-type'] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"success":true,"result":{"access_token":"tajny-token"}}');
    });
  });

  const client = new HttpClient({ retries: 0 });
  const form = 'grant_type=password&client_id=abc&client_secret=bardzo-tajne&username=jan&password=haslo123456';
  const { data } = await client.request(s.url('/oauth2/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    rawBody: form,
  });

  assert.equal(data.result.access_token, 'tajny-token');
  assert.equal(seen.body, form, 'treść formularza nie może być przepakowana do JSON');
  assert.equal(seen.contentType, 'application/x-www-form-urlencoded');

  const logged = client.recentLog()[0].body;
  assert.match(logged, /grant_type=password/);
  assert.equal(logged.includes('bardzo-tajne'), false, 'client_secret nie może trafić do dziennika');
  assert.equal(logged.includes('haslo123456'), false, 'hasło nie może trafić do dziennika');
  assert.match(logged, /client_id=/);
  await s.close();
});
