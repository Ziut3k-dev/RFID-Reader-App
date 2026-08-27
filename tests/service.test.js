import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../shared/store.js';
import { ScanService } from '../shared/service.js';

/** Adapter trzymający bazę w pamięci — testy nie dotykają dysku. */
function memoryAdapter(initial = null) {
  let text = initial;
  return {
    label: 'memory',
    read: () => text,
    write: (value) => { text = value; },
    quarantine: () => { text = null; },
    dump: () => text,
  };
}

function fresh(settings = {}) {
  const store = new Store(memoryAdapter());
  store.setSettings({ debounceSeconds: 0, ...settings });
  return { store, service: new ScanService(store) };
}

test('nieznana karta: odmowa i zapis w historii', () => {
  const { store, service } = fresh();
  const res = service.processScan('0004372425');

  assert.equal(res.ok, true);
  assert.equal(res.decision, 'unknown');
  assert.equal(res.card, null);
  assert.equal(res.uid.hex, '0042B7C9');
  assert.equal(store.listScans().total, 1);
});

test('znana i aktywna karta: dostęp przyznany', () => {
  const { service } = fresh();
  service.enroll({ uid: '0004372425', label: 'Karta 1', owner: 'Anna' });

  const res = service.processScan('0004372425');
  assert.equal(res.decision, 'granted');
  assert.equal(res.card.label, 'Karta 1');
});

test('karta zapisana w trybie DEC odnajduje się po odczycie z odwróconymi bajtami', () => {
  const { service } = fresh();
  service.enroll({ uid: '0004372425', label: 'Karta 1' });

  const res = service.processScan('C9B74200');
  assert.equal(res.decision, 'granted', res.reason);
  assert.equal(res.card.label, 'Karta 1');
});

test('zablokowana karta: odmowa z powodem', () => {
  const { store, service } = fresh();
  const card = service.enroll({ uid: '0004372425', label: 'Karta 1' });
  store.updateCard(card.id, { active: false });

  const res = service.processScan('0004372425');
  assert.equal(res.decision, 'denied');
  assert.match(res.reason, /zablokowana/);
});

test('tryb nauki dopisuje nieznaną kartę', () => {
  const { store, service } = fresh({ unknownPolicy: 'enroll' });
  const res = service.processScan('0004372425');

  assert.equal(res.decision, 'granted');
  assert.equal(store.listCards().length, 1);
  assert.match(res.card.note, /automatycznie/);
});

test('powtórny odczyt w oknie blokady nie trafia do historii', () => {
  const { store, service } = fresh({ debounceSeconds: 30 });
  service.enroll({ uid: '0004372425', label: 'Karta 1' });

  assert.equal(service.processScan('0004372425').decision, 'granted');
  const second = service.processScan('0004372425');
  assert.equal(second.decision, 'duplicate');
  assert.equal(second.scan, null);
  assert.equal(store.listScans().total, 1, 'historia ma zawierać tylko pierwszy odczyt');
});

test('dopisanie karty poprawia ostatni odczyt "nieznana" w historii', () => {
  const { store, service } = fresh();
  service.processScan('0004372425');
  assert.equal(store.listScans().rows[0].decision, 'unknown');

  service.enroll({ uidHex: '0042B7C9', label: 'Karta 1' });
  const row = store.listScans().rows[0];
  assert.equal(row.decision, 'granted');
  assert.equal(row.cardLabel, 'Karta 1');
});

test('nierozpoznany odczyt zwraca błąd, nie wyjątek', () => {
  const { store, service } = fresh();
  const res = service.processScan('!!!');

  assert.equal(res.ok, false);
  assert.match(res.error, /nieprawid/i);
  assert.equal(store.listScans().total, 0);
});

test('duplikat numeru karty jest odrzucany przy zapisie', () => {
  const { service } = fresh();
  service.enroll({ uid: '0004372425', label: 'Pierwsza' });
  assert.throws(() => service.enroll({ uid: '0004372425', label: 'Druga' }), /już zapisana/);
});

test('diagnostyka pokazuje odczyt we wszystkich trybach', () => {
  const { service } = fresh();
  const out = service.inspect('12345678');

  assert.equal(out.hex.hex, '12345678');
  assert.equal(out.dec.hex, '00BC614E');
  assert.equal(out.activeFormat, 'auto');
  assert.ok(service.inspect('ABC!').dec.error);
});

test('odczyt z odwróconymi bajtami zapisuje się pod kanonicznym numerem karty', () => {
  const { store, service } = fresh();
  service.enroll({ uid: '0004372425', label: 'Karta 1' });

  service.processScan('C9B74200');
  const row = store.listScans().rows[0];
  assert.equal(row.uidHex, '0042B7C9', 'historia ma używać numeru karty z bazy');
  assert.equal(row.uidRaw, 'C9B74200', 'surowy odczyt musi zostać zachowany');
  assert.equal(store.stats().uniqueToday, 1, 'to jedna karta, nie dwie');
});
