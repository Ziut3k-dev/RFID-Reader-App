import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, DEFAULT_SETTINGS, toCsv } from '../shared/store.js';

function memoryAdapter(initial = null) {
  const state = { text: initial, quarantined: false };
  return {
    label: 'memory',
    read: () => state.text,
    write: (value) => { state.text = value; },
    quarantine: () => { state.quarantined = true; state.text = null; },
    state,
  };
}

test('nowa baza dostaje ustawienia domyślne', () => {
  const store = new Store(memoryAdapter());
  assert.deepEqual(store.getSettings(), DEFAULT_SETTINGS);
});

test('ustawienia są walidowane i zaokrąglane do dozwolonych wartości', () => {
  const store = new Store(memoryAdapter());
  const s = store.setSettings({ uidFormat: 'bzdura', unknownPolicy: 'x', debounceSeconds: -5, maxScans: 1 });

  assert.equal(s.uidFormat, 'auto');
  assert.equal(s.unknownPolicy, 'deny');
  assert.equal(s.debounceSeconds, 0);
  assert.equal(s.maxScans, 100);
});

test('dane przetrwają ponowne wczytanie z tego samego adaptera', () => {
  const adapter = memoryAdapter();
  const first = new Store(adapter);
  first.createCard({ uidHex: '0042B7C9', uidDec: '0004372425', label: 'Karta 1' });
  first.addScan({ uidHex: '0042B7C9', decision: 'granted' });
  first.flush();

  const second = new Store(adapter);
  assert.equal(second.listCards().length, 1);
  assert.equal(second.listScans().total, 1);
  assert.equal(second.listCards()[0].label, 'Karta 1');
});

test('uszkodzony plik jest odkładany na bok, a nie nadpisywany po cichu', () => {
  const adapter = memoryAdapter('{ to nie jest JSON');
  const store = new Store(adapter);

  assert.equal(adapter.state.quarantined, true);
  assert.equal(store.listCards().length, 0);
});

test('limit historii usuwa najstarsze odczyty', () => {
  const store = new Store(memoryAdapter());
  store.setSettings({ maxScans: 100 });
  for (let i = 0; i < 130; i += 1) {
    store.addScan({ uidHex: '0042B7C9', decision: 'granted' });
  }
  const { total, rows } = store.listScans({ limit: 5 });
  assert.equal(total, 100);
  // Historia zwracana jest od najnowszego odczytu.
  assert.equal(rows[0].id, 130);
});

test('usunięcie karty zachowuje historię bez powiązania', () => {
  const store = new Store(memoryAdapter());
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '0004372425', label: 'Karta 1' });
  store.addScan({ uidHex: '0042B7C9', cardId: card.id, decision: 'granted' });

  assert.equal(store.deleteCard(card.id), true);
  const row = store.listScans().rows[0];
  assert.equal(row.cardId, null);
  assert.equal(store.listScans().total, 1);
});

test('filtrowanie historii po wyniku, dacie i treści', () => {
  const store = new Store(memoryAdapter());
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'Magazyn' });
  store.addScan({ ts: '2026-08-20T08:00:00.000Z', uidHex: '0042B7C9', cardId: card.id, decision: 'granted' });
  store.addScan({ ts: '2026-08-25T08:00:00.000Z', uidHex: 'DEADBEEF', decision: 'unknown' });

  assert.equal(store.listScans({ decision: 'unknown' }).total, 1);
  assert.equal(store.listScans({ from: '2026-08-24' }).total, 1);
  assert.equal(store.listScans({ to: '2026-08-21' }).total, 1);
  assert.equal(store.listScans({ q: 'magazyn' }).total, 1);
  assert.equal(store.listScans({ q: 'nie ma takiego' }).total, 0);
});

test('statystyki liczą tylko dzisiejsze odczyty', () => {
  const store = new Store(memoryAdapter());
  store.addScan({ uidHex: '0042B7C9', decision: 'granted' });
  store.addScan({ uidHex: '0042B7C9', decision: 'granted' });
  store.addScan({ uidHex: 'DEADBEEF', decision: 'denied' });
  store.addScan({ ts: '2020-01-01T00:00:00.000Z', uidHex: 'AABBCCDD', decision: 'granted' });

  const stats = store.stats();
  assert.equal(stats.today, 3);
  assert.equal(stats.uniqueToday, 2);
  assert.equal(stats.granted, 2);
  assert.equal(stats.denied, 1);
  assert.equal(stats.scansTotal, 4);
});

test('CSV cytuje pola z przecinkami i cudzysłowami', () => {
  const csv = toCsv(['a', 'b'], [['zwykłe', 'z, przecinkiem'], ['z "cudzysłowem"', '']]);
  assert.equal(csv, 'a,b\r\nzwykłe,"z, przecinkiem"\r\n"z ""cudzysłowem""",\r\n');
});

test('eksport kart zawiera nagłówek i wiersze', () => {
  const store = new Store(memoryAdapter());
  store.createCard({ uidHex: '0042B7C9', uidDec: '0004372425', label: 'Karta 1', owner: 'Anna' });
  const csv = store.cardsCsv();

  assert.match(csv.split('\r\n')[0], /^id,uid_hex,uid_dec,label/);
  assert.match(csv, /Karta 1,Anna/);
});

test('karta dostaje puste powiązanie, a setCardLink je uzupełnia', () => {
  const store = new Store(memoryAdapter());
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'K1' });
  assert.equal(card.link.state, 'none');
  assert.equal(card.link.provider, '');

  store.setCardLink(card.id, {
    provider: 'akuvox',
    siteName: 'Kwiatowa 3',
    apartmentName: 'm. 12',
    residentName: 'Anna Kowalska',
    state: 'pending',
  });
  const linked = store.getCard(card.id);
  assert.equal(linked.link.residentName, 'Anna Kowalska');
  assert.equal(linked.link.state, 'pending');
  // Pola nieprzekazane zachowują wartości domyślne, nie znikają.
  assert.equal(linked.link.remoteId, '');
});

test('karty zapisane przed integracją dostają pole link przy odczycie', () => {
  // Baza z poprzedniej wersji aplikacji: karta bez pola link.
  const legacy = JSON.stringify({
    version: 1,
    settings: {},
    cards: [{ id: 1, uidHex: '0042B7C9', uidDec: '1', label: 'Stara', active: true }],
    scans: [],
    nextCardId: 2,
    nextScanId: 1,
  });
  const store = new Store(memoryAdapter(legacy));

  assert.equal(store.getCard(1).link.state, 'none');
  assert.equal(store.listCards()[0].link.provider, '');
});

test('lista niezsynchronizowanych obejmuje oczekujące, błędne i usuwane', () => {
  const store = new Store(memoryAdapter());
  const states = ['none', 'pending', 'synced', 'error', 'removing'];
  states.forEach((state, i) => {
    const card = store.createCard({ uidHex: `0042B7C${i}`, uidDec: String(i), label: state });
    store.setCardLink(card.id, { provider: 'akuvox', state });
  });

  const pending = store.listUnsyncedCards().map((c) => c.link.state).sort();
  assert.deepEqual(pending, ['error', 'pending', 'removing']);
});

test('szukanie kart obejmuje mieszkańca i obiekt z integracji', () => {
  const store = new Store(memoryAdapter());
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'K1' });
  store.setCardLink(card.id, { provider: 'akuvox', residentName: 'Anna Kowalska', siteName: 'Kwiatowa 3' });

  assert.equal(store.listCards({ q: 'kowalska' }).length, 1);
  assert.equal(store.listCards({ q: 'kwiatowa' }).length, 1);
  assert.equal(store.listCards({ q: 'nie ma' }).length, 0);
});

test('eksport kart zawiera kolumny powiązania', () => {
  const store = new Store(memoryAdapter());
  const card = store.createCard({ uidHex: '0042B7C9', uidDec: '1', label: 'K1' });
  store.setCardLink(card.id, { provider: 'akuvox', siteName: 'Kwiatowa 3', residentName: 'Anna', state: 'synced' });

  const csv = store.cardsCsv();
  assert.match(csv.split('\r\n')[0], /integracja,obiekt,mieszkanie,mieszkaniec,stan_synchronizacji$/);
  assert.match(csv, /akuvox,Kwiatowa 3,,Anna,synced/);
});
