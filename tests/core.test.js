import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUid, lookupKeys, evaluate, UidError } from '../shared/core.js';

test('tryb dziesiętny czytnika — 10 cyfr z zerami wiodącymi', () => {
  const uid = parseUid('0004372425');
  assert.equal(uid.hex, '0042B7C9');
  assert.equal(uid.dec10, '0004372425');
  assert.equal(uid.bytes, 4);
  assert.equal(uid.source, 'dec');
});

test('tryb HEX czytnika — 8 znaków', () => {
  const uid = parseUid('0042B7C9');
  assert.equal(uid.hex, '0042B7C9');
  assert.equal(uid.dec10, '0004372425');
  assert.equal(uid.source, 'hex');
});

test('ten sam numer w trybie DEC i HEX daje ten sam klucz', () => {
  assert.equal(parseUid('0004372425').hex, parseUid('0042B7C9').hex);
});

test('format Wiegand — numer bierzemy z pierwszego pola', () => {
  const uid = parseUid('0004372425,0042,44873');
  assert.equal(uid.hex, '0042B7C9');
  assert.equal(uid.source, 'wiegand');
});

test('7-bajtowy UID z separatorami', () => {
  const uid = parseUid('04:A2:2B:9C:11:44:80');
  assert.equal(uid.hex, '04A22B9C114480');
  assert.equal(uid.bytes, 7);
  assert.equal(uid.pretty, '04:A2:2B:9C:11:44:80');
});

test('odwrócona kolejność bajtów jest symetryczna', () => {
  const uid = parseUid('0042B7C9');
  assert.equal(uid.hexReversed, 'C9B74200');
  assert.equal(parseUid(uid.hexReversed).hexReversed, uid.hex);
});

test('wymuszony tryb rozstrzyga ciąg ośmiu cyfr', () => {
  assert.equal(parseUid('12345678', 'hex').hex, '12345678');
  assert.equal(parseUid('12345678', 'dec').hex, '00BC614E');
  // W trybie auto osiem znaków to HEX — czytnik w trybie DEC dopełnia do dziesięciu.
  assert.equal(parseUid('12345678', 'auto').hex, '12345678');
});

test('błędne odczyty są odrzucane z komunikatem', () => {
  for (const bad of ['', '   ', 'ZZZZ', 'karta-XYZ', '0'.repeat(40)]) {
    assert.throws(() => parseUid(bad), UidError, `powinno odrzucić: ${bad}`);
  }
  assert.throws(() => parseUid('ABCDEF', 'dec'), UidError);
});

test('klucze wyszukiwania obejmują obie kolejności bajtów', () => {
  assert.deepEqual(lookupKeys(parseUid('0042B7C9')), ['0042B7C9', 'C9B74200']);
  // Numer symetryczny nie jest dublowany.
  assert.deepEqual(lookupKeys(parseUid('AABBBBAA', 'hex')), ['AABBBBAA']);
});

test('reguły dostępu', () => {
  const now = new Date('2026-08-27T10:00:00Z');

  assert.equal(evaluate({ card: null, now }).decision, 'unknown');
  assert.equal(evaluate({ card: { active: true }, now }).decision, 'granted');
  assert.equal(evaluate({ card: { active: false }, now }).decision, 'denied');
  assert.equal(evaluate({ card: { active: true, validTo: '2026-08-26' }, now }).decision, 'denied');
  assert.equal(evaluate({ card: { active: true, validTo: '2026-08-27' }, now }).decision, 'granted');
  assert.equal(evaluate({ card: { active: true, validFrom: '2026-08-28' }, now }).decision, 'denied');
  assert.equal(evaluate({ card: { active: true, validFrom: '2026-08-27' }, now }).decision, 'granted');
});

test('blokada powtórnego odczytu działa w zadanym oknie', () => {
  const now = new Date('2026-08-27T10:00:00Z');
  const settings = { debounceSeconds: 3 };
  const within = new Date(now.getTime() - 1500).toISOString();
  const after = new Date(now.getTime() - 5000).toISOString();

  assert.equal(evaluate({ card: { active: true }, now, settings, lastScanTs: within }).decision, 'duplicate');
  assert.equal(evaluate({ card: { active: true }, now, settings, lastScanTs: after }).decision, 'granted');
  // Zerowe okno wyłącza mechanizm.
  assert.equal(
    evaluate({ card: { active: true }, now, settings: { debounceSeconds: 0 }, lastScanTs: within }).decision,
    'granted',
  );
  // Blokada obowiązuje też karty nieznane — inaczej trzymanie obcej karty
  // przy czytniku zasypałoby historię.
  assert.equal(evaluate({ card: null, now, settings, lastScanTs: within }).decision, 'duplicate');
});
