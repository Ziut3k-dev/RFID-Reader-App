/**
 * Magazyn danych aplikacji — karty, historia odczytów, ustawienia.
 *
 * Sama logika jest czysta i nie zna środowiska: zapis i odczyt trafiają do
 * wstrzykniętego adaptera (`{ read(), write(text) }`). Dzięki temu ten sam kod
 * obsługuje proces główny Electrona (plik JSON na dysku, zapis atomowy)
 * i podgląd aplikacji w przeglądarce (localStorage) — bez dublowania reguł.
 */

export const DEFAULT_SETTINGS = {
  /** Interpretacja odczytu: auto | dec | hex */
  uidFormat: 'auto',
  /** Nieznana karta: deny (odmowa) | enroll (dopisz automatycznie) */
  unknownPolicy: 'deny',
  /** Ignoruj powtórny odczyt tej samej karty w ciągu N sekund */
  debounceSeconds: 3,
  /** Nazwa stanowiska zapisywana w historii */
  station: 'default',
  /** Dźwięk przy odczycie */
  sound: true,
  /** Maksymalna liczba przechowywanych odczytów (starsze są usuwane) */
  maxScans: 50000,
  /** Serwer dla telefonu jako skanera — domyślnie wyłączony (otwiera port w sieci) */
  bridgeEnabled: false,
  /** Port serwera telefonu */
  bridgePort: 8787,
  /** Sekret w adresie sparowania; puste = wygeneruj przy pierwszym starcie */
  bridgeToken: '',

  /** Integracja z chmurą Akuvox (akubela OpenAPI) */
  akuvoxEnabled: false,
  akuvoxRegion: 'ecloud-pre',
  akuvoxBaseUrl: 'https://api.ecloud.pre.akubela.com',
  /** Postać numeru karty wysyłana do chmury: dec | dec10 | hex | hexReversed */
  akuvoxCardFormat: 'dec',
  akuvoxClientId: '',
  akuvoxUsername: '',
  /** Tryb podglądu: pokazuj zapytania, nie wysyłaj ich */
  akuvoxDryRun: false,

  /** Kto wydaje karty — podpis w protokole przekazania */
  installerName: '',
  /**
   * Tryb offline: przypisania odkładamy do kolejki i nie próbujemy wysyłać.
   * Na budowie bez zasięgu każda próba to kilkanaście sekund czekania na limit
   * czasu — lepiej zebrać wszystko i wysłać raz.
   */
  offlineQueue: false,
  /** Automatyczne dosyłanie zaległych, gdy wróci łączność */
  autoSync: true,
};

/**
 * Powiązanie karty z systemem zewnętrznym (np. chmurą Akuvox): do którego
 * obiektu i mieszkańca karta została przypisana i czy zmiana doszła do chmury.
 * Trzymane przy karcie, bo to jej właściwość, a nie osobny rejestr — dzięki
 * temu usunięcie karty nie zostawia sieroty w mapowaniu.
 */
export const EMPTY_LINK = {
  provider: '',        // '' = karta nie jest nigdzie przypisana
  connectionId: '',    // które połączenie (klient/chmura) — instalator ma ich wiele
  siteId: '',
  siteName: '',
  apartmentId: '',
  apartmentName: '',
  residentId: '',
  residentName: '',
  remoteId: '',        // identyfikator karty nadany przez system zewnętrzny
  state: 'none',       // none | pending | synced | error | removing
  syncedAt: '',
  error: '',
  /** Potwierdzenie odczytem: chmura odpowiedziała „ok”, ale czy karta tam jest */
  verified: false,
  verifiedAt: '',
  /** Kto wydał kartę — trafia do protokołu przekazania */
  assignedBy: '',
  /** Wymiana zgubionej karty: id poprzedniej karty i powód */
  replacesCardId: 0,
  replacementReason: '',
};

/** Połączenie z chmurą jednego klienta. Instalator obsługuje kilka obiektów. */
export const EMPTY_CONNECTION = {
  id: '',
  name: '',
  provider: 'akuvox',
  region: 'ecloud-pre',
  baseUrl: 'https://api.ecloud.pre.akubela.com',
  clientId: '',
  username: '',
  cardFormat: 'dec',
  dryRun: false,
  createdAt: '',
};

const EMPTY = {
  version: 2,
  settings: { ...DEFAULT_SETTINGS },
  cards: [],
  scans: [],
  connections: [],
  activeConnectionId: '',
  nextCardId: 1,
  nextScanId: 1,
};

export class Store {
  /** @param {{read: () => string|null, write: (text: string) => void, label?: string, quarantine?: () => void}} adapter */
  constructor(adapter) {
    this.adapter = adapter;
    this.file = adapter.label || 'pamięć';
    this.data = structuredClone(EMPTY);
    this._writeTimer = null;
    this.load();
  }

  /**
   * Przenosi jedną konfigurację z ustawień na listę połączeń. Instalator
   * dostaje kilka klientów, a wcześniejsze wersje miały tylko jedną chmurę —
   * bez tego jego dotychczasowe ustawienia po prostu by zniknęły z widoku.
   */
  #migrateConnections() {
    if (this.data.connections?.length) return;
    const s = this.data.settings || {};
    if (!s.akuvoxClientId && !s.akuvoxBaseUrl) return;

    const id = 'conn-1';
    this.data.connections = [{
      ...EMPTY_CONNECTION,
      id,
      name: 'Połączenie z poprzedniej wersji',
      region: s.akuvoxRegion || EMPTY_CONNECTION.region,
      baseUrl: s.akuvoxBaseUrl || EMPTY_CONNECTION.baseUrl,
      clientId: s.akuvoxClientId || '',
      username: s.akuvoxUsername || '',
      cardFormat: s.akuvoxCardFormat || 'dec',
      dryRun: Boolean(s.akuvoxDryRun),
      createdAt: new Date().toISOString(),
    }];
    this.data.activeConnectionId = id;
    // Karty przypisane przed podziałem na połączenia należą do tego jednego.
    for (const card of this.data.cards) {
      if (card.link?.provider && !card.link.connectionId) card.link.connectionId = id;
    }
    this.migratedConnectionId = id;
    this.save();
  }

  load() {
    let raw = null;
    try {
      raw = this.adapter.read();
    } catch {
      raw = null;
    }
    if (!raw) {
      this.data = structuredClone(EMPTY);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      this.data = {
        ...structuredClone(EMPTY),
        ...parsed,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      };
    } catch {
      // Uszkodzonych danych nie nadpisujemy w ciszy — adapter odkłada je na bok.
      this.adapter.quarantine?.();
      this.data = structuredClone(EMPTY);
      this.flush();
      return;
    }
    this.#migrateConnections();
  }

  // --- połączenia z chmurą ---------------------------------------------------

  listConnections() {
    return (this.data.connections || []).map((c) => ({ ...EMPTY_CONNECTION, ...c }));
  }

  activeConnection() {
    const list = this.listConnections();
    if (!list.length) return null;
    return list.find((c) => c.id === this.data.activeConnectionId) || list[0];
  }

  setActiveConnection(id) {
    if (id && !(this.data.connections || []).some((c) => c.id === id)) {
      throw new Error(`Nie ma połączenia o id ${id}`);
    }
    this.data.activeConnectionId = id || '';
    this.save();
    return this.activeConnection();
  }

  saveConnection(input) {
    const list = this.data.connections || (this.data.connections = []);
    const clean = {
      name: String(input.name || '').trim().slice(0, 120) || 'Bez nazwy',
      region: String(input.region || EMPTY_CONNECTION.region).slice(0, 40),
      baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''),
      clientId: String(input.clientId || '').trim().slice(0, 200),
      username: String(input.username || '').trim().slice(0, 200),
      cardFormat: ['dec', 'dec10', 'hex', 'hexReversed'].includes(input.cardFormat) ? input.cardFormat : 'dec',
      dryRun: Boolean(input.dryRun),
    };

    if (input.id) {
      const existing = list.find((c) => c.id === input.id);
      if (!existing) throw new Error(`Nie ma połączenia o id ${input.id}`);
      Object.assign(existing, clean);
      this.save();
      return { ...EMPTY_CONNECTION, ...existing };
    }

    const id = `conn-${Date.now().toString(36)}-${list.length + 1}`;
    const created = { ...EMPTY_CONNECTION, ...clean, id, createdAt: new Date().toISOString() };
    list.push(created);
    if (!this.data.activeConnectionId) this.data.activeConnectionId = id;
    this.save();
    return created;
  }

  /** @returns {{removed: boolean, unlinkedCards: number}} */
  deleteConnection(id) {
    const list = this.data.connections || [];
    const index = list.findIndex((c) => c.id === id);
    if (index === -1) return { removed: false, unlinkedCards: 0 };

    list.splice(index, 1);
    // Karty tego klienta tracą powiązanie, ale zostają w bazie odczytów —
    // usunięcie połączenia nie może po cichu wyczyścić historii wydań.
    let unlinkedCards = 0;
    for (const card of this.data.cards) {
      if (card.link?.connectionId === id) {
        card.link = { ...EMPTY_LINK };
        unlinkedCards += 1;
      }
    }
    if (this.data.activeConnectionId === id) {
      this.data.activeConnectionId = list[0]?.id || '';
    }
    this.save();
    return { removed: true, unlinkedCards };
  }

  /** Zapis odroczony — seria szybkich odczytów nie wywoła serii zapisów. */
  save() {
    this._dirty = true;
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.flush();
    }, 250);
  }

  flush() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    this._dirty = false;
    this.adapter.write(JSON.stringify(this.data, null, 2));
  }

  // --- ustawienia -----------------------------------------------------------

  getSettings() {
    return { ...this.data.settings };
  }

  setSettings(patch) {
    const next = { ...this.data.settings, ...patch };
    next.debounceSeconds = Math.max(0, Number(next.debounceSeconds) || 0);
    next.maxScans = Math.max(100, Number(next.maxScans) || DEFAULT_SETTINGS.maxScans);
    if (!['auto', 'dec', 'hex'].includes(next.uidFormat)) next.uidFormat = 'auto';
    if (!['deny', 'enroll'].includes(next.unknownPolicy)) next.unknownPolicy = 'deny';
    next.station = String(next.station || 'default').slice(0, 60);
    next.sound = Boolean(next.sound);
    next.bridgeEnabled = Boolean(next.bridgeEnabled);
    // Porty poniżej 1024 wymagają uprawnień administratora, powyżej 65535 nie istnieją.
    const port = Number(next.bridgePort);
    next.bridgePort = Number.isInteger(port) && port >= 1024 && port <= 65535
      ? port
      : DEFAULT_SETTINGS.bridgePort;
    next.bridgeToken = /^[0-9a-f]{0,64}$/.test(String(next.bridgeToken || ''))
      ? String(next.bridgeToken || '')
      : '';

    next.akuvoxEnabled = Boolean(next.akuvoxEnabled);
    next.akuvoxDryRun = Boolean(next.akuvoxDryRun);
    next.akuvoxRegion = String(next.akuvoxRegion || DEFAULT_SETTINGS.akuvoxRegion).slice(0, 40);
    next.akuvoxBaseUrl = String(next.akuvoxBaseUrl || '').trim().replace(/\/+$/, '');
    if (!['dec', 'dec10', 'hex', 'hexReversed'].includes(next.akuvoxCardFormat)) {
      next.akuvoxCardFormat = DEFAULT_SETTINGS.akuvoxCardFormat;
    }
    next.akuvoxClientId = String(next.akuvoxClientId || '').trim().slice(0, 200);
    next.akuvoxUsername = String(next.akuvoxUsername || '').trim().slice(0, 200);
    next.installerName = String(next.installerName || '').trim().slice(0, 120);
    next.offlineQueue = Boolean(next.offlineQueue);
    next.autoSync = Boolean(next.autoSync);
    this.data.settings = next;
    this.save();
    return this.getSettings();
  }

  // --- karty ----------------------------------------------------------------

  listCards({ q = '', activeOnly = false } = {}) {
    const needle = q.trim().toLowerCase();
    return this.data.cards
      .filter((c) => (activeOnly ? c.active : true))
      .filter((c) => {
        if (!needle) return true;
        return [c.label, c.owner, c.role, c.note, c.uidHex, c.uidDec,
                c.link?.residentName, c.link?.apartmentName, c.link?.siteName]
          .join(' ')
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => (a.label || a.uidHex).localeCompare(b.label || b.uidHex, 'pl'))
      .map((c) => ({ ...c, link: { ...EMPTY_LINK, ...c.link }, scanCount: this.countScans(c.id) }));
  }

  getCard(id) {
    const card = this.data.cards.find((c) => c.id === id);
    if (!card) return null;
    // Karty zapisane przed dodaniem integracji nie mają pola link,
    // a zapisane przed rozbudową nie mają nowszych pól.
    card.link = { ...EMPTY_LINK, ...card.link };
    return card;
  }

  /**
   * Zapisuje stan powiązania karty z systemem zewnętrznym. Osobna metoda,
   * bo updateCard celowo nie przyjmuje pola link — stan synchronizacji zmienia
   * usługa integracji, nie formularz edycji karty.
   */
  setCardLink(id, patch) {
    const card = this.getCard(id);
    if (!card) throw new Error(`Nie ma karty o id ${id}`);
    card.link = { ...EMPTY_LINK, ...card.link, ...patch };
    card.updatedAt = new Date().toISOString();
    this.save();
    return card;
  }

  /** Karty czekające na wysłanie do systemu zewnętrznego albo z błędem. */
  listUnsyncedCards() {
    return this.data.cards.filter((c) => {
      const state = c.link?.state;
      return state === 'pending' || state === 'error' || state === 'removing';
    });
  }

  /** Szukanie po obu kolejnościach bajtów — patrz lookupKeys() w shared/core.js. */
  findCardByKeys(keys) {
    return this.data.cards.find((c) => keys.includes(c.uidHex)) || null;
  }

  createCard(input) {
    const existing = this.findCardByKeys([input.uidHex]);
    if (existing) {
      const err = new Error(`Karta ${input.uidHex} jest już zapisana jako "${existing.label || 'bez nazwy'}"`);
      err.code = 'DUPLICATE_CARD';
      throw err;
    }
    const now = new Date().toISOString();
    const card = {
      id: this.data.nextCardId++,
      uidHex: input.uidHex,
      uidDec: input.uidDec ?? '',
      bytes: input.bytes ?? 4,
      label: (input.label ?? '').trim(),
      owner: (input.owner ?? '').trim(),
      role: input.role || 'user',
      active: input.active === undefined ? true : Boolean(input.active),
      validFrom: input.validFrom || null,
      validTo: input.validTo || null,
      note: (input.note ?? '').trim(),
      link: { ...EMPTY_LINK, ...(input.link || {}) },
      createdAt: now,
      updatedAt: now,
    };
    this.data.cards.push(card);
    this.save();
    return card;
  }

  updateCard(id, patch) {
    const card = this.getCard(id);
    if (!card) throw new Error(`Nie ma karty o id ${id}`);
    const allowed = ['label', 'owner', 'role', 'active', 'validFrom', 'validTo', 'note'];
    for (const key of allowed) {
      if (key in patch) card[key] = key === 'active' ? Boolean(patch[key]) : patch[key];
    }
    card.validFrom = card.validFrom || null;
    card.validTo = card.validTo || null;
    card.updatedAt = new Date().toISOString();
    this.save();
    return card;
  }

  deleteCard(id) {
    const index = this.data.cards.findIndex((c) => c.id === id);
    if (index === -1) return false;
    this.data.cards.splice(index, 1);
    // Historia zostaje — odczyty tracą tylko powiązanie z kartą.
    for (const scan of this.data.scans) {
      if (scan.cardId === id) scan.cardId = null;
    }
    this.save();
    return true;
  }

  // --- historia odczytów -----------------------------------------------------

  addScan(record) {
    const scan = {
      id: this.data.nextScanId++,
      ts: record.ts || new Date().toISOString(),
      uidHex: record.uidHex,
      uidRaw: record.uidRaw ?? '',
      cardId: record.cardId ?? null,
      decision: record.decision,
      reason: record.reason ?? '',
      station: record.station || this.data.settings.station,
    };
    this.data.scans.push(scan);
    const max = this.data.settings.maxScans;
    if (this.data.scans.length > max) {
      this.data.scans.splice(0, this.data.scans.length - max);
    }
    this.save();
    return scan;
  }

  countScans(cardId) {
    let n = 0;
    for (const s of this.data.scans) if (s.cardId === cardId) n += 1;
    return n;
  }

  lastScanTs(keys, { excludeId = null } = {}) {
    for (let i = this.data.scans.length - 1; i >= 0; i -= 1) {
      const s = this.data.scans[i];
      if (s.id === excludeId) continue;
      if (keys.includes(s.uidHex)) return s.ts;
    }
    return null;
  }

  listScans({ limit = 200, offset = 0, decision = '', q = '', from = '', to = '' } = {}) {
    const needle = q.trim().toLowerCase();
    const byId = new Map(this.data.cards.map((c) => [c.id, c]));
    const filtered = [];
    for (let i = this.data.scans.length - 1; i >= 0; i -= 1) {
      const s = this.data.scans[i];
      if (decision && s.decision !== decision) continue;
      const day = s.ts.slice(0, 10);
      if (from && day < from) continue;
      if (to && day > to) continue;
      const card = s.cardId ? byId.get(s.cardId) : null;
      if (needle) {
        const hay = [s.uidHex, s.uidRaw, s.station, s.reason, card?.label, card?.owner]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      filtered.push({
        ...s,
        cardLabel: card?.label || '',
        cardOwner: card?.owner || '',
      });
    }
    return { total: filtered.length, rows: filtered.slice(offset, offset + limit) };
  }

  stats() {
    const today = new Date().toISOString().slice(0, 10);
    const counters = { granted: 0, denied: 0, unknown: 0, duplicate: 0 };
    let todayTotal = 0;
    const uniqueToday = new Set();
    for (const s of this.data.scans) {
      if (s.ts.slice(0, 10) !== today) continue;
      todayTotal += 1;
      uniqueToday.add(s.uidHex);
      if (s.decision in counters) counters[s.decision] += 1;
    }
    return {
      cards: this.data.cards.length,
      cardsActive: this.data.cards.filter((c) => c.active).length,
      scansTotal: this.data.scans.length,
      today: todayTotal,
      uniqueToday: uniqueToday.size,
      ...counters,
    };
  }

  // --- eksport ---------------------------------------------------------------

  cardsCsv() {
    const head = [
      'id', 'uid_hex', 'uid_dec', 'label', 'owner', 'role', 'active', 'valid_from', 'valid_to',
      'note', 'created_at', 'integracja', 'obiekt', 'mieszkanie', 'mieszkaniec', 'stan_synchronizacji',
    ];
    const rows = this.listCards().map((c) => [
      c.id, c.uidHex, c.uidDec, c.label, c.owner, c.role, c.active ? 1 : 0,
      c.validFrom || '', c.validTo || '', c.note, c.createdAt,
      c.link.provider, c.link.siteName, c.link.apartmentName, c.link.residentName, c.link.state,
    ]);
    return toCsv(head, rows);
  }

  scansCsv(filter = {}) {
    const head = ['id', 'timestamp', 'uid_hex', 'uid_raw', 'decision', 'reason', 'card_label', 'card_owner', 'station'];
    const { rows } = this.listScans({ ...filter, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    return toCsv(head, rows.map((s) => [
      s.id, s.ts, s.uidHex, s.uidRaw, s.decision, s.reason, s.cardLabel, s.cardOwner, s.station,
    ]));
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(head, rows) {
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
