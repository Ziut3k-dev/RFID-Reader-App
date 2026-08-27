/**
 * Profil REST — opis obcego API danymi, nie kodem.
 *
 * Integracja z chmurą Akuvox ma jedną niewygodną cechę: dokładne ścieżki, nazwy
 * pól i sposób uwierzytelniania zależą od wersji chmury i od tego, co partner
 * dostał w dokumentacji. Zamiast wpisywać je na sztywno i wypuszczać nową wersję
 * aplikacji przy każdej różnicy, trzymamy je w profilu: szablony ścieżek,
 * szablony treści zapytań i ścieżki do pól w odpowiedzi.
 *
 * Dzięki temu dostrojenie integracji do konkretnego wdrożenia jest zmianą
 * konfiguracji, a nie kodu — i da się ją zrobić w oknie aplikacji.
 */

/** Wypełnia szablon `{nazwa}` wartościami; brakująca zmienna to błąd. */
export function renderTemplate(template, vars = {}) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_all, name) => {
    const value = vars[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Szablon "${template}" wymaga wartości "${name}"`);
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * Odczytuje wartość ze struktury po ścieżce `a.b[0].c`.
 * Pusta ścieżka zwraca całą strukturę — API zwracające gołą tablicę
 * nie wymaga wtedy sztucznego opakowania.
 */
export function pickPath(source, path) {
  if (path === undefined || path === null || path === '') return source;
  let current = source;
  for (const part of String(path).split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) return undefined;
    const [, key, indexes] = match;
    if (key) {
      if (current === null || typeof current !== 'object') return undefined;
      current = current[key];
    }
    for (const index of indexes.match(/\d+/g) || []) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index)];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** Głęboko podstawia zmienne w szablonie treści zapytania. */
export function renderBody(template, vars = {}) {
  if (template === null || template === undefined) return template;
  if (typeof template === 'string') return renderTemplate(template, vars);
  if (Array.isArray(template)) return template.map((item) => renderBody(item, vars));
  if (typeof template === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(template)) out[key] = renderBody(value, vars);
    return out;
  }
  return template;
}

/**
 * Zamienia odpowiedź API na listę pozycji {id, name, extra} według mapowania.
 * `listPath` wskazuje tablicę, `idField`/`nameField` — pola w jej elementach.
 */
export function mapList(response, mapping = {}) {
  const raw = pickPath(response, mapping.listPath);
  if (!Array.isArray(raw)) {
    throw new Error(
      `Pod ścieżką "${mapping.listPath ?? '(korzeń)'}" nie ma tablicy` +
      (raw === undefined ? ' — sprawdź listPath w profilu' : ` (jest ${typeof raw})`),
    );
  }
  return raw.map((item, index) => {
    const id = pickPath(item, mapping.idField ?? 'id');
    const name = pickPath(item, mapping.nameField ?? 'name');
    return {
      id: id === undefined || id === null ? '' : String(id),
      // Bez nazwy lista byłaby nie do użycia w oknie wyboru, więc dajemy
      // czytelne zastępstwo zamiast pustego wiersza.
      name: name === undefined || name === null || name === ''
        ? `(bez nazwy ${index + 1})`
        : String(name),
      extra: mapping.extraField ? pickPath(item, mapping.extraField) : undefined,
      raw: item,
    };
  });
}

/** Operacje, których wymaga scenariusz „przypisz kartę mieszkańcowi”. */
export const REQUIRED_OPERATIONS = ['sites', 'apartments', 'residents', 'assignCard'];
export const OPTIONAL_OPERATIONS = ['login', 'unassignCard', 'ping'];
export const ALL_OPERATIONS = [...REQUIRED_OPERATIONS, ...OPTIONAL_OPERATIONS];

/**
 * Sprawdza profil przed użyciem. Zwraca listę problemów po polsku —
 * lepiej pokazać je w oknie ustawień niż pozwolić na serię zapytań 404.
 */
export function validateProfile(profile) {
  const problems = [];
  if (!profile || typeof profile !== 'object') return ['Profil jest pusty.'];

  const base = String(profile.baseUrl || '').trim();
  if (!base) problems.push('Brak adresu bazowego API.');
  else if (!/^https?:\/\//i.test(base)) problems.push('Adres bazowy musi zaczynać się od http:// albo https://.');
  else if (/^http:\/\//i.test(base) && !/^http:\/\/(localhost|127\.|192\.168\.|10\.)/i.test(base)) {
    problems.push('Adres bazowy używa nieszyfrowanego http — klucz API poszedłby w postaci jawnej.');
  }

  const auth = profile.auth || {};
  const types = ['none', 'header', 'bearer', 'basic', 'login'];
  if (!types.includes(auth.type)) {
    problems.push(`Nieznany sposób uwierzytelniania "${auth.type}" (dozwolone: ${types.join(', ')}).`);
  }
  if (auth.type === 'header' && !auth.headerName) problems.push('Uwierzytelnianie nagłówkiem wymaga nazwy nagłówka.');
  if (auth.type === 'login' && !profile.operations?.login) problems.push('Uwierzytelnianie logowaniem wymaga operacji "login".');

  for (const name of REQUIRED_OPERATIONS) {
    const op = profile.operations?.[name];
    if (!op) {
      problems.push(`Brak opisu operacji "${name}".`);
      continue;
    }
    if (!op.path) problems.push(`Operacja "${name}" nie ma ścieżki.`);
    if (op.method && !/^(GET|POST|PUT|PATCH|DELETE)$/i.test(op.method)) {
      problems.push(`Operacja "${name}" ma nieprawidłową metodę "${op.method}".`);
    }
  }
  return problems;
}

/**
 * Szkielet profilu do wypełnienia danymi z dokumentacji partnerskiej Akuvox.
 * Ścieżki celowo puste: wpisanie tu wymyślonych końcówek dawałoby złudzenie,
 * że integracja jest gotowa, a kończyłoby się serią 404 u użytkownika.
 */
export const EMPTY_PROFILE = {
  name: 'Akuvox — do wypełnienia',
  baseUrl: '',
  auth: { type: 'header', headerName: 'X-Auth-Token', prefix: '' },
  operations: {
    ping: { method: 'GET', path: '' },
    login: { method: 'POST', path: '', body: {}, tokenPath: '' },
    sites: { method: 'GET', path: '', listPath: '', idField: 'id', nameField: 'name' },
    apartments: { method: 'GET', path: '', listPath: '', idField: 'id', nameField: 'name' },
    residents: { method: 'GET', path: '', listPath: '', idField: 'id', nameField: 'name' },
    assignCard: { method: 'POST', path: '', body: {}, remoteIdPath: '' },
    unassignCard: { method: 'DELETE', path: '' },
  },
  /** Postać numeru karty wysyłana do API: hex | hexReversed | dec | dec10 */
  cardFormat: 'hex',
};
