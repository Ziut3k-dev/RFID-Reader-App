import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_PROFILE, mapList, pickPath, renderBody, renderTemplate, validateProfile,
} from '../shared/rest-profile.js';

test('szablony ścieżek podstawiają wartości i kodują je do adresu', () => {
  assert.equal(renderTemplate('/api/site/{siteId}/apartments', { siteId: 42 }), '/api/site/42/apartments');
  assert.equal(renderTemplate('/a/{x}', { x: 'a b/c' }), '/a/a%20b%2Fc');
  assert.equal(renderTemplate('/bez/zmiennych', {}), '/bez/zmiennych');
});

test('brakująca zmienna w szablonie jest błędem, nie pustym miejscem', () => {
  // Wstawienie pustego napisu dałoby zapytanie do /api/site//apartments,
  // czyli 404 zamiast czytelnego komunikatu.
  assert.throws(() => renderTemplate('/api/site/{siteId}', {}), /wymaga wartości "siteId"/);
  assert.throws(() => renderTemplate('/api/site/{siteId}', { siteId: '' }), /wymaga wartości/);
});

test('odczyt pól po ścieżce, także z tablic', () => {
  const data = { result: { list: [{ id: 7, profile: { name: 'Anna' } }] }, plain: [1, 2] };
  assert.equal(pickPath(data, 'result.list[0].id'), 7);
  assert.equal(pickPath(data, 'result.list[0].profile.name'), 'Anna');
  assert.deepEqual(pickPath(data, 'plain'), [1, 2]);
  assert.equal(pickPath(data, 'nie.ma.tego'), undefined);
  // Pusta ścieżka zwraca całość — API zwracające gołą tablicę też ma działać.
  assert.deepEqual(pickPath([1, 2], ''), [1, 2]);
});

test('szablon treści zapytania podstawia zmienne w głąb struktury', () => {
  const body = renderBody(
    { card: { number: '{uid}', type: 1 }, owner: ['{residentId}'], stale: true },
    { uid: '0042B7C9', residentId: 'r-5' },
  );
  assert.deepEqual(body, { card: { number: '0042B7C9', type: 1 }, owner: ['r-5'], stale: true });
});

test('mapowanie listy z zagnieżdżonej odpowiedzi', () => {
  const response = { data: { items: [{ uid: 'a1', title: 'Kwiatowa 3' }, { uid: 'a2', title: 'Polna 7' }] } };
  const list = mapList(response, { listPath: 'data.items', idField: 'uid', nameField: 'title' });

  assert.deepEqual(list.map((i) => i.id), ['a1', 'a2']);
  assert.deepEqual(list.map((i) => i.name), ['Kwiatowa 3', 'Polna 7']);
  assert.equal(list[0].raw.title, 'Kwiatowa 3');
});

test('mapowanie listy: brak nazwy dostaje zastępstwo, zła ścieżka daje czytelny błąd', () => {
  const list = mapList({ items: [{ id: 1 }] }, { listPath: 'items' });
  assert.equal(list[0].name, '(bez nazwy 1)');

  assert.throws(
    () => mapList({ items: {} }, { listPath: 'items' }),
    /nie ma tablicy \(jest object\)/,
  );
  assert.throws(
    () => mapList({}, { listPath: 'nie.ma' }),
    /sprawdź listPath/,
  );
});

test('mapowanie listy przyjmuje odpowiedź będącą gołą tablicą', () => {
  const list = mapList([{ id: 3, name: 'Anna' }], {});
  assert.equal(list[0].id, '3');
  assert.equal(list[0].name, 'Anna');
});

test('pusty profil nie przechodzi walidacji i mówi, czego brakuje', () => {
  const problems = validateProfile(EMPTY_PROFILE);
  assert.ok(problems.some((p) => /adresu bazowego/i.test(p)));
  for (const op of ['sites', 'apartments', 'residents', 'assignCard']) {
    assert.ok(problems.some((p) => p.includes(`"${op}"`)), `powinno zgłosić brak ścieżki dla ${op}`);
  }
});

test('walidacja profilu wyłapuje typowe pomyłki w konfiguracji', () => {
  const base = {
    baseUrl: 'https://api.example.com',
    auth: { type: 'header', headerName: 'X-Token' },
    operations: {
      sites: { method: 'GET', path: '/s' },
      apartments: { method: 'GET', path: '/a' },
      residents: { method: 'GET', path: '/r' },
      assignCard: { method: 'POST', path: '/c' },
    },
  };
  assert.deepEqual(validateProfile(base), []);

  assert.ok(validateProfile({ ...base, baseUrl: 'api.example.com' })
    .some((p) => /http:\/\/ albo https:\/\//.test(p)));

  // Nieszyfrowane http poza siecią lokalną wysłałoby klucz API jawnym tekstem.
  assert.ok(validateProfile({ ...base, baseUrl: 'http://api.example.com' })
    .some((p) => /nieszyfrowanego http/.test(p)));
  assert.deepEqual(validateProfile({ ...base, baseUrl: 'http://192.168.1.10:8080' }), []);

  assert.ok(validateProfile({ ...base, auth: { type: 'magia' } }).some((p) => /Nieznany sposób/.test(p)));
  assert.ok(validateProfile({ ...base, auth: { type: 'header' } }).some((p) => /nazwy nagłówka/.test(p)));
  assert.ok(validateProfile({ ...base, auth: { type: 'login' } }).some((p) => /operacji "login"/.test(p)));
  assert.ok(validateProfile({
    ...base,
    operations: { ...base.operations, sites: { method: 'ZROB', path: '/s' } },
  }).some((p) => /nieprawidłową metodę/.test(p)));
});

test('nazwa pozycji może mieć pola zapasowe', () => {
  const response = {
    list: [
      { id: 1, account_name: 'anna.k', first_name: 'Anna' },
      { id: 2, account_name: '', first_name: 'Jan' },
      { id: 3, account_name: '   ', first_name: '', email: 'x@example.com' },
      { id: 4 },
    ],
  };
  const items = mapList(response, {
    listPath: 'list',
    nameField: ['account_name', 'first_name', 'email'],
  });
  assert.deepEqual(items.map((i) => i.name), ['anna.k', 'Jan', 'x@example.com', '(bez nazwy 4)']);
});
