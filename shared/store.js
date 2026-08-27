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
};

const EMPTY = { version: 1, settings: { ...DEFAULT_SETTINGS }, cards: [], scans: [], nextCardId: 1, nextScanId: 1 };

export class Store {
  /** @param {{read: () => string|null, write: (text: string) => void, label?: string, quarantine?: () => void}} adapter */
  constructor(adapter) {
    this.adapter = adapter;
    this.file = adapter.label || 'pamięć';
    this.data = structuredClone(EMPTY);
    this._writeTimer = null;
    this.load();
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
    }
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
        return [c.label, c.owner, c.role, c.note, c.uidHex, c.uidDec]
          .join(' ')
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => (a.label || a.uidHex).localeCompare(b.label || b.uidHex, 'pl'))
      .map((c) => ({ ...c, scanCount: this.countScans(c.id) }));
  }

  getCard(id) {
    return this.data.cards.find((c) => c.id === id) || null;
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
    const head = ['id', 'uid_hex', 'uid_dec', 'label', 'owner', 'role', 'active', 'valid_from', 'valid_to', 'note', 'created_at'];
    const rows = this.listCards().map((c) => [
      c.id, c.uidHex, c.uidDec, c.label, c.owner, c.role, c.active ? 1 : 0,
      c.validFrom || '', c.validTo || '', c.note, c.createdAt,
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
