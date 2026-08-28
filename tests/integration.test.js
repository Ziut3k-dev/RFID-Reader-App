import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../shared/store.js';
import { IntegrationService, cardNumberFor, handoverCsv, handoverRows } from '../shared/integration.js';
import { AKUVOX_PROFILE } from '../shared/akuvox-profile.js';
import { RestAdapter } from '../electron/rest-adapter.js';
import { HttpClient } from '../electron/http-client.js';

function memoryAdapter() {
  let text = null;
  return { label: 'memory', read: () => text, write: (v) => { text = v; }, quarantine: () => { text = null; } };
}

/**
 * Atrapa chmury akubela: te same kształty odpowiedzi, co w dokumentacji
 * (koperta {success, timestamp, result}, jeden adres na komendy).
 */
async function fakeCloud(options = {}) {
  const state = {
    commands: [],
    tokenIssued: 0,
    refreshUsed: 0,
    cards: [],
    failNext401: options.failNext401 ?? 0,
    forceCommandError: options.forceCommandError ?? null,
    swallowCards: options.swallowCards ?? false,
    residentCount: options.residentCount ?? 2,
  };

  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.url.endsWith('/versions')) {
        return send(200, { success: true, timestamp: 1, result: { version: 'V4.1' } });
      }

      if (req.url.endsWith('/oauth2/token')) {
        const form = new URLSearchParams(raw);
        if (form.get('grant_type') === 'refresh_token') {
          state.refreshUsed += 1;
          if (!form.get('refresh_token')) return send(400, { success: false, message: 'brak refresh_token' });
        } else {
          if (form.get('scope') !== 'manager') return send(400, { success: false, message: 'zły scope' });
          if (!form.get('client_secret') || !form.get('password')) {
            return send(400, { success: false, message: 'brak poświadczeń' });
          }
        }
        state.tokenIssued += 1;
        return send(200, {
          success: true,
          timestamp: 1,
          result: {
            access_token: `token-${state.tokenIssued}`,
            refresh_token: 'refresh-1',
            token_type: 'bearer',
            expires_in: options.expiresIn ?? 3600,
          },
        });
      }

      if (req.url.endsWith('/manager-commands')) {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer token-')) return send(401, { success: false, message: 'brak tokenu' });
        if (state.failNext401 > 0) {
          state.failNext401 -= 1;
          return send(401, { success: false, message: 'token wygasł' });
        }

        const body = JSON.parse(raw || '{}');
        state.commands.push(body);
        if (!/^[0-9a-f]{32}$/.test(body.id || '')) {
          return send(200, { success: false, message: 'pole id musi mieć 32 znaki HEX' });
        }
        if (state.forceCommandError === body.command) {
          return send(200, { success: false, message: 'numer karty już istnieje w projekcie' });
        }
        const p = body.param || {};

        switch (body.command) {
          case 'get_project_list':
            return send(200, { success: true, result: { list: [
              { project_id: 'p1', project_name: 'Kwiatowa 3' },
              { project_id: 'p2', project_name: 'Polna 7' },
            ] } });
          case 'get_building_list':
            return send(200, { success: true, result: { list: [
              { building_id: 'b1', building_name: 'Klatka A' },
            ] } });
          case 'get_family_list':
            return send(200, { success: true, result: { list: [
              { residence_id: 'r1', family_name: 'Kowalscy', residence_no: '101' },
              { residence_id: 'r2', family_name: '', residence_no: '102' },
            ] } });
          case 'get_user_list': {
            const list = [
              { account_id: 'a1', account_name: 'anna.k', first_name: 'Anna', residence_id: 'r1' },
              { account_id: 'a2', account_name: '', first_name: 'Jan', residence_id: 'r2' },
            ].slice(0, state.residentCount);
            return send(200, { success: true, result: { list } });
          }
          case 'get_user_access_info':
            return send(200, { success: true, result: {
              rf_cards: state.cards.filter((c) => c.account_id === p.account_id),
              pin_codes: [], faces: [], access_groups: [],
            } });
          case 'create_user_rf_card_access_info': {
            for (const field of ['project_id', 'residence_id', 'account_id', 'number']) {
              if (!p[field]) return send(200, { success: false, message: `brak param.${field}` });
            }
            const rf_card_id = `card-${state.cards.length + 1}`;
            if (!state.swallowCards) {
              state.cards.push({ rf_card_id, number: p.number, account_id: p.account_id });
            }
            return send(200, { success: true, result: { rf_card_id } });
          }
          case 'delete_user_rf_card_access_info': {
            const before = state.cards.length;
            state.cards = state.cards.filter((c) => c.rf_card_id !== p.rf_card_id);
            if (state.cards.length === before) return send(200, { success: false, message: 'nie ma takiej karty' });
            return send(200, { success: true, result: {} });
          }
          default:
            return send(200, { success: false, message: `nieznana komenda ${body.command}` });
        }
      }

      send(404, { success: false, message: 'nie ma takiej ścieżki' });
    });
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  // Bez unref nieudany test, który nie doszedł do close(), trzymałby pętlę
  // zdarzeń i cały plik kończyłby się dopiero limitem czasu.
  srv.unref();
  const { port } = srv.address();
  const cloud = { state, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) };
  OPEN_CLOUDS.add(cloud);
  return cloud;
}

/** Atrapy zamykamy zbiorczo — pojedynczy nieudany test nie zostawi wiszącego portu. */
const OPEN_CLOUDS = new Set();
after(async () => {
  await Promise.all([...OPEN_CLOUDS].map((c) => c.close().catch(() => {})));
  OPEN_CLOUDS.clear();
});

function setup(cloud, overrides = {}) {
  const store = new Store(memoryAdapter());
  const profile = { ...AKUVOX_PROFILE, baseUrl: cloud.baseUrl, providerId: 'akuvox', ...overrides };
  const adapter = new RestAdapter({
    profile,
    credentials: { clientId: 'cid', clientSecret: 'csecret', username: 'zarzadca', password: 'haslo' },
    http: new HttpClient({ retries: 0, timeoutMs: 4000 }),
  });
  const service = new IntegrationService({ store, adapter: () => adapter });
  return { store, adapter, service, profile };
}

const TARGET = {
  siteId: 'p1', siteName: 'Kwiatowa 3',
  apartmentId: 'r1', apartmentName: 'Kowalscy (101)',
  residentId: 'a1', residentName: 'Anna',
};

test('sprawdzenie połączenia przechodzi trzy kroki po kolei', async () => {
  const cloud = await fakeCloud();
  const { service } = setup(cloud);

  const res = await service.test();
  assert.equal(res.ok, true);
  assert.deepEqual(res.steps.map((s) => s.step), ['łączność', 'poświadczenia', 'obiekty']);
  assert.match(res.steps[2].detail, /widoczne obiekty: 2/);
  await cloud.close();
});

test('błąd poświadczeń zatrzymuje sprawdzenie na właściwym kroku', async () => {
  const cloud = await fakeCloud();
  const { service, adapter } = setup(cloud);
  adapter.credentials.password = '';

  const res = await service.test();
  assert.equal(res.ok, false);
  assert.equal(res.steps.at(-1).step, 'poświadczenia');
  assert.equal(res.steps.at(-1).ok, false);
  await cloud.close();
});

test('hierarchia: obiekty, budynki, mieszkania i mieszkańcy mapują się na listy', async () => {
  const cloud = await fakeCloud();
  const { service } = setup(cloud);

  assert.deepEqual((await service.sites()).map((s) => `${s.id}:${s.name}`), ['p1:Kwiatowa 3', 'p2:Polna 7']);
  assert.deepEqual((await service.buildings('p1')).map((b) => b.name), ['Klatka A']);

  const apartments = await service.apartments('p1');
  assert.equal(apartments[0].name, 'Kowalscy');
  assert.equal(apartments[0].extra, '101', 'numer lokalu przydaje się w oknie wyboru');
  assert.equal(apartments[1].name, '(bez nazwy 2)', 'mieszkanie bez nazwy dostaje zastępstwo');

  const residents = await service.residents('p1');
  assert.deepEqual(residents.map((r) => r.name), ['anna.k', 'Jan'], 'puste account_name zastąpione imieniem');
  await cloud.close();
});

test('mieszkańcy filtrowani po mieszkaniu, bo API nie ma takiego filtru', async () => {
  const cloud = await fakeCloud();
  const { service } = setup(cloud);

  assert.deepEqual((await service.residents('p1', 'r2')).map((r) => r.id), ['a2']);
  assert.deepEqual((await service.residents('p1', 'r1')).map((r) => r.id), ['a1']);
  await cloud.close();
});

test('przypisanie karty: stan synced, identyfikator zdalny i numer w ustawionym formacie', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud, { cardFormat: 'dec' });
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '0004372425', label: 'Karta 1' });

  const res = await service.assign(card.id, TARGET);
  assert.equal(res.ok, true);
  assert.equal(res.cardNumber, '4372425', 'format dec — bez zer wiodących');
  assert.equal(res.remoteId, 'card-1');

  const link = store.getCard(card.id).link;
  assert.equal(link.state, 'synced');
  assert.equal(link.provider, 'akuvox');
  assert.equal(link.residentName, 'Anna');
  assert.equal(link.apartmentName, 'Kowalscy (101)');
  assert.ok(link.syncedAt);

  // Numer poszedł tam, gdzie dokumentacja go oczekuje. Szukamy komendy
  // przypisania, bo po niej leci jeszcze potwierdzenie odczytem.
  const sent = cloud.state.commands.find((c) => c.command === 'create_user_rf_card_access_info');
  assert.ok(sent, 'powinna polecieć komenda przypisania karty');
  assert.equal(sent.param.number, '4372425');
  assert.equal(sent.param.project_id, 'p1');
  assert.equal(sent.param.residence_id, 'r1');
  assert.equal(sent.param.account_id, 'a1');
  await cloud.close();
});

test('format numeru karty da się zmienić bez zmiany kodu', async () => {
  const card = { uidHex: '0042B7C9' };
  assert.equal(cardNumberFor(card, 'dec'), '4372425');
  assert.equal(cardNumberFor(card, 'dec10'), '0004372425');
  assert.equal(cardNumberFor(card, 'hex'), '0042B7C9');
  assert.equal(cardNumberFor(card, 'hexReversed'), 'C9B74200');
  assert.throws(() => cardNumberFor(card, 'ósemkowo'), /Nieznany format/);

  const cloud = await fakeCloud();
  const { store, service } = setup(cloud, { cardFormat: 'hexReversed' });
  const saved = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'K' });
  await service.assign(saved.id, TARGET);
  const assignCommand = cloud.state.commands.find((c) => c.command === 'create_user_rf_card_access_info');
  assert.equal(assignCommand.param.number, 'C9B74200');
  await cloud.close();
});

test('odmowa chmury zostawia kartę w stanie błędu z powodem, nie udaje sukcesu', async () => {
  const cloud = await fakeCloud({ forceCommandError: 'create_user_rf_card_access_info' });
  const { store, service } = setup(cloud);
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Karta 1' });

  const res = await service.assign(card.id, TARGET);
  assert.equal(res.ok, false);
  assert.match(res.error, /numer karty już istnieje/);

  const link = store.getCard(card.id).link;
  assert.equal(link.state, 'error');
  assert.match(link.error, /już istnieje/);
  // Wybór obiektu i mieszkańca zostaje, żeby dało się ponowić bez wybierania od nowa.
  assert.equal(link.residentId, 'a1');
  await cloud.close();
});

test('błąd logiczny z kodem HTTP 200 nie przechodzi jako sukces', async () => {
  const cloud = await fakeCloud();
  const { adapter } = setup(cloud);
  await adapter.ensureToken();

  await assert.rejects(
    () => adapter.run('sites', {}).then(() => adapter.run('nieistniejaca', {})),
    /nie opisuje operacji/,
  );
  await cloud.close();
});

test('odebranie karty usuwa ją w chmurze i czyści powiązanie', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Karta 1' });
  await service.assign(card.id, TARGET);

  const res = await service.unassign(card.id);
  assert.equal(res.ok, true);
  assert.equal(cloud.state.cards.length, 0);

  const link = store.getCard(card.id).link;
  assert.equal(link.state, 'none');
  assert.equal(link.provider, '');
  assert.equal(link.residentId, '');
  await cloud.close();
});

test('karta bez identyfikatora zdalnego jest odwiązywana lokalnie, z informacją', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Karta 1' });
  store.setCardLink(card.id, { provider: 'akuvox', state: 'error', residentId: 'a1' });

  const res = await service.unassign(card.id);
  assert.equal(res.ok, true);
  assert.equal(res.localOnly, true);
  assert.match(res.message, /tylko lokalnie/);
  assert.equal(store.getCard(card.id).link.provider, '');
  await cloud.close();
});

test('wygasły token jest odświeżany, a nie wymusza pełnego logowania', async () => {
  // Margines przed wygaśnięciem to 60 s, więc expires_in = 60 s daje token
  // uznawany za stary natychmiast — tak wymuszamy ścieżkę odświeżania.
  const cloud = await fakeCloud({ expiresIn: 60 });
  const { service } = setup(cloud);

  await service.sites();
  assert.equal(cloud.state.refreshUsed, 0, 'pierwsze wywołanie to zwykłe logowanie');
  await service.sites();
  assert.equal(cloud.state.refreshUsed, 1, 'drugie ma odświeżyć token, nie logować się od nowa');
  await cloud.close();
});

test('odpowiedź 401 w trakcie pracy powoduje jedno ponowne logowanie i powtórzenie zapytania', async () => {
  const cloud = await fakeCloud();
  const { service, adapter } = setup(cloud);
  await adapter.ensureToken();
  cloud.state.failNext401 = 1;

  const sites = await service.sites();
  assert.equal(sites.length, 2, 'zapytanie ma się udać po odświeżeniu tokenu');
  assert.ok(cloud.state.tokenIssued >= 2);
  await cloud.close();
});

test('przypisanie potwierdza się odczytem kart mieszkańca', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Karta 1' });

  const res = await service.assign(card.id, TARGET, { installerName: 'Jan Instalator' });
  assert.equal(res.ok, true);
  assert.equal(res.verified, true, 'karta ma być widoczna u mieszkańca po zapisie');

  const link = store.getCard(card.id).link;
  assert.equal(link.verified, true);
  assert.ok(link.verifiedAt);
  assert.equal(link.assignedBy, 'Jan Instalator');
  // Po przypisaniu poleciało pytanie o poświadczenia mieszkańca.
  assert.ok(cloud.state.commands.some((c) => c.command === 'get_user_access_info'));
});

test('brak karty po stronie chmury jest zgłaszany, a nie przemilczany', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Karta 1' });

  // Chmura przyjmuje zapis, ale „gubi” kartę — dokładnie ten przypadek,
  // przed którym ma chronić potwierdzenie odczytem.
  cloud.state.swallowCards = true;
  const res = await service.assign(card.id, TARGET);

  assert.equal(res.ok, true, 'sam zapis się udał');
  assert.equal(res.verified, false);
  const link = store.getCard(card.id).link;
  assert.equal(link.verified, false);
  assert.match(link.error, /nie widać u mieszkańca/);
});

test('tryb offline odkłada przypisanie bez wysyłki', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Karta 1' });

  const res = await service.assign(card.id, TARGET, { offline: true, installerName: 'Jan' });
  assert.equal(res.queued, true);
  assert.equal(cloud.state.commands.length, 0, 'nic nie leci do chmury');

  const link = store.getCard(card.id).link;
  assert.equal(link.state, 'pending');
  assert.equal(link.residentName, 'Anna', 'cel zapisany, żeby dało się dosłać później');

  // Po odzyskaniu łączności zaległe idą jednym ponowieniem.
  const retry = await service.retryPending();
  assert.equal(retry.ok, 1);
  assert.equal(store.getCard(card.id).link.state, 'synced');
  assert.equal(store.getCard(card.id).link.assignedBy, 'Jan', 'kto wydał kartę nie może zginąć w kolejce');
});

test('ostrzeżenia przed przypisaniem: karta zajęta, mieszkaniec z kartą, numer w chmurze', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const first = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Pierwsza' });
  const second = store.createCard({ uidHex: '0042B7CA', uidDec: '2', label: 'Druga' });

  assert.deepEqual(await service.checkAssign(first.id, TARGET), [], 'czysta sytuacja bez ostrzeżeń');

  await service.assign(first.id, TARGET);

  const warnings = await service.checkAssign(second.id, TARGET);
  const codes = warnings.map((w) => w.code);
  assert.ok(codes.includes('mieszkaniec-ma-karte'), JSON.stringify(codes));

  const again = await service.checkAssign(first.id, TARGET);
  const againCodes = again.map((w) => w.code);
  assert.ok(againCodes.includes('karta-juz-przypisana'));
  assert.ok(againCodes.includes('numer-juz-w-chmurze'));
});

test('wymiana zgubionej karty: stara odebrana i zablokowana, nowa wydana', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const lost = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Zgubiona' });
  const fresh = store.createCard({ uidHex: '0042B7CA', uidDec: '2', label: 'Nowa' });
  await service.assign(lost.id, TARGET);

  const res = await service.replaceCard(lost.id, fresh.id, 'zgubiona w piwnicy', { installerName: 'Jan' });
  assert.equal(res.ok, true);
  assert.equal(res.stage, 'gotowe');

  const oldCard = store.getCard(lost.id);
  assert.equal(oldCard.active, false, 'zgubiona karta musi zostać zablokowana, nie usunięta');
  assert.match(oldCard.note, /zgubiona w piwnicy/i);
  assert.equal(oldCard.link.provider, '', 'stara karta nie jest już przypisana');

  const newCard = store.getCard(fresh.id);
  assert.equal(newCard.link.state, 'synced');
  assert.equal(newCard.link.residentId, 'a1');
  assert.equal(newCard.link.replacesCardId, lost.id);
  assert.match(newCard.link.replacementReason, /piwnicy/);

  // W chmurze została dokładnie jedna karta — nowa (UID 0042B7CA = 4372426).
  assert.equal(cloud.state.cards.length, 1);
  assert.equal(cloud.state.cards[0].number, '4372426');
});

test('wymiana odmawia, gdy stara karta nie jest przypisana', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const a = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'A' });
  const b = store.createCard({ uidHex: '0042B7CA', uidDec: '2', label: 'B' });

  await assert.rejects(() => service.replaceCard(a.id, b.id, 'powód'), /nie jest przypisana/);
  await assert.rejects(() => service.replaceCard(a.id, a.id, 'powód'), /ta sama karta/);
});

test('protokół przekazania zawiera wydania, stan i podpis instalatora', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Karta 1' });
  await service.assign(card.id, TARGET, { installerName: 'Jan Instalator', connectionId: 'conn-1' });

  const rows = handoverRows(store, { cardFormat: 'dec' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mieszkanie, 'Kowalscy (101)');
  assert.equal(rows[0].mieszkaniec, 'Anna');
  assert.equal(rows[0].numer, '4372425');
  assert.equal(rows[0].wydal, 'Jan Instalator');
  assert.match(rows[0].stan, /potwierdzona/);

  const csv = handoverCsv(store, { cardFormat: 'dec' });
  assert.match(csv.split('\r\n')[0], /^obiekt,mieszkanie,mieszkaniec,karta,uid,numer,stan,wydal,data,uwagi$/);
  assert.match(csv, /Kowalscy \(101\),Anna,Karta 1,0042B7C9,4372425/);

  // Filtr po połączeniu — instalator ma w bazie karty kilku klientów.
  assert.equal(handoverRows(store, { connectionId: 'conn-1' }).length, 1);
  assert.equal(handoverRows(store, { connectionId: 'conn-inny' }).length, 0);
});

test('każde polecenie dostaje własny 32-znakowy identyfikator', async () => {
  const cloud = await fakeCloud();
  const { service } = setup(cloud);
  await service.sites();
  await service.apartments('p1');

  const ids = cloud.state.commands.map((c) => c.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => /^[0-9a-f]{32}$/.test(id)));
  assert.notEqual(ids[0], ids[1]);
  await cloud.close();
});

test('ponowienie wysyła zaległe karty i raportuje wynik', async () => {
  const cloud = await fakeCloud({ forceCommandError: 'create_user_rf_card_access_info' });
  const { store, service } = setup(cloud);
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Karta 1' });
  await service.assign(card.id, TARGET);
  assert.equal(store.getCard(card.id).link.state, 'error');

  // Chmura przestaje odmawiać — ponowienie ma dokończyć robotę.
  cloud.state.forceCommandError = null;
  const res = await service.retryPending();
  assert.equal(res.total, 1);
  assert.equal(res.ok, 1);
  assert.equal(store.getCard(card.id).link.state, 'synced');
  await cloud.close();
});

test('przypisanie bez wybranego mieszkańca jest odrzucane przed wysyłką', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Karta 1' });

  await assert.rejects(() => service.assign(card.id, { siteId: 'p1', apartmentId: 'r1' }), /residentId/);
  assert.equal(cloud.state.commands.length, 0, 'nic nie powinno polecieć do chmury');
  await cloud.close();
});

test('poświadczenia mieszkańca pokazują karty już zapisane w chmurze', async () => {
  const cloud = await fakeCloud();
  const { store, service } = setup(cloud);
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Karta 1' });
  await service.assign(card.id, TARGET);

  const cards = await service.residentCards({ siteId: 'p1', apartmentId: 'r1', residentId: 'a1' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, '4372425');
  await cloud.close();
});
