/**
 * Logika wspólna dla procesu głównego Electrona i interfejsu React.
 * Czysty JavaScript bez zależności — jedno źródło prawdy dla parsowania
 * numerów kart i reguł dostępu.
 *
 * Czytniki HID typu Sycreader / ProRock emulują klawiaturę i "wpisują" numer
 * karty. Ten sam identyfikator, zależnie od konfiguracji sprzętowej, przychodzi
 * jako:
 *
 *   0004372425             10 cyfr dziesiętnych dopełnionych zerami (tryb DEC)
 *   0042B4C9               8 znaków HEX (tryb HEX)
 *   C9B44200               HEX z odwróconą kolejnością bajtów (LSB first)
 *   0004372425,0042,44873  format Wiegand — numer jest w pierwszym polu
 *   04:A2:2B:9C:11:44:80   7-bajtowy UID z separatorami
 */

const HEX = new Set('0123456789ABCDEF');

export class UidError extends Error {}

/** Ile bajtów zajmuje UID o danej wartości liczbowej: 4 (S50/S70) lub 7. */
function padLength(value) {
  let need = 1;
  let v = value;
  while (v > 255n) {
    need += 1;
    v >>= 8n;
  }
  if (need <= 4) return 4;
  if (need <= 7) return 7;
  return need;
}

function fromBigInt(value, byteLength) {
  let hex = value.toString(16).toUpperCase();
  return hex.padStart(byteLength * 2, '0');
}

function makeUid(hex, raw, source) {
  const bytes = hex.length / 2;
  const reversed = (hex.match(/../g) || []).reverse().join('');
  const dec = BigInt('0x' + (hex || '0'));
  const width = bytes <= 4 ? 10 : 17;
  return {
    hex,
    hexReversed: reversed,
    pretty: (hex.match(/../g) || []).join(':'),
    dec: dec.toString(),
    dec10: dec.toString().padStart(width, '0'),
    bytes,
    raw,
    source,
  };
}

/**
 * Zamienia surowy odczyt czytnika na znormalizowany identyfikator.
 * `fmt` rozstrzyga przypadki niejednoznaczne (ciąg samych cyfr może być
 * liczbą dziesiętną albo zapisem HEX):
 *   auto — 10+ cyfr to DEC, dokładnie 8 znaków to HEX
 *   dec  — zawsze liczba dziesiętna
 *   hex  — zawsze zapis HEX
 */
export function parseUid(raw, fmt = 'auto') {
  if (raw === null || raw === undefined) throw new UidError('brak odczytu');
  let text = String(raw).trim();
  if (!text) throw new UidError('puste odczytanie');

  let source = 'hex';
  if (text.includes(',') || text.includes(';')) {
    source = 'wiegand';
    const first = text.replace(/;/g, ',').split(',').map((p) => p.trim()).find(Boolean);
    if (!first) throw new UidError(`nie znaleziono numeru w odczycie: ${raw}`);
    text = first;
  }

  const clean = text.toUpperCase().replace(/[\s:_.\-]/g, '');
  if (!clean) throw new UidError(`odczyt nie zawiera numeru: ${raw}`);
  if (clean.length > 32) throw new UidError(`odczyt zbyt długi (${clean.length} znaków)`);
  for (const ch of clean) {
    if (!HEX.has(ch)) throw new UidError(`odczyt zawiera nieprawidłowe znaki: ${raw}`);
  }

  const digitsOnly = /^[0-9]+$/.test(clean);

  const asDec = () => {
    const value = BigInt(clean);
    return makeUid(fromBigInt(value, padLength(value)), String(raw), source === 'wiegand' ? 'wiegand' : 'dec');
  };
  const asHex = () => {
    const padded = clean.length % 2 ? '0' + clean : clean;
    return makeUid(padded, String(raw), source);
  };

  if (fmt === 'dec') {
    if (!digitsOnly) throw new UidError(`tryb DEC, a odczyt nie jest liczbą: ${raw}`);
    return asDec();
  }
  if (fmt === 'hex') return asHex();
  if (fmt !== 'auto') throw new UidError(`nieznany tryb odczytu: ${fmt}`);

  // Tryb auto: czytnik w trybie dziesiętnym dopełnia numer do 10 cyfr,
  // w trybie HEX wysyła dokładnie 8 znaków — długość rozstrzyga spór.
  if (digitsOnly && clean.length !== 8) return asDec();
  return asHex();
}

/**
 * Klucze, po których szukamy karty w bazie. Kolejność bajtów bywa różna
 * między trybem DEC i HEX tego samego czytnika, więc karta zapisana w jednym
 * trybie musi się odnaleźć po odczycie w drugim.
 */
export function lookupKeys(uid) {
  return uid.hex === uid.hexReversed ? [uid.hex] : [uid.hex, uid.hexReversed];
}

export const DECISION = {
  GRANTED: 'granted',
  DENIED: 'denied',
  UNKNOWN: 'unknown',
  DUPLICATE: 'duplicate',
};

/** Początek dnia karty ważnej "od" — daty trzymamy jako YYYY-MM-DD. */
function outsideValidity(card, now) {
  const day = now.toISOString().slice(0, 10);
  if (card.validFrom && day < card.validFrom) return `karta ważna od ${card.validFrom}`;
  if (card.validTo && day > card.validTo) return `karta wygasła ${card.validTo}`;
  return null;
}

/**
 * Reguły dostępu. Czysta funkcja — łatwa do przetestowania i niezależna
 * od bazy danych.
 *
 * @param {object} card      karta z bazy albo null, gdy nieznana
 * @param {Date}   now       moment odczytu
 * @param {object} settings  { debounceSeconds, unknownPolicy }
 * @param {string|null} lastScanTs  ISO czasu poprzedniego odczytu tej karty
 */
export function evaluate({ card, now = new Date(), settings = {}, lastScanTs = null }) {
  const debounce = Number(settings.debounceSeconds ?? 3);
  if (lastScanTs && debounce > 0) {
    const delta = (now.getTime() - new Date(lastScanTs).getTime()) / 1000;
    if (delta >= 0 && delta < debounce) {
      return { decision: DECISION.DUPLICATE, reason: `powtórny odczyt w ciągu ${debounce}s` };
    }
  }

  if (!card) {
    return { decision: DECISION.UNKNOWN, reason: 'karta nieznana — nie ma jej w bazie' };
  }
  if (!card.active) {
    return { decision: DECISION.DENIED, reason: 'karta zablokowana' };
  }
  const validity = outsideValidity(card, now);
  if (validity) {
    return { decision: DECISION.DENIED, reason: validity };
  }
  return { decision: DECISION.GRANTED, reason: 'dostęp przyznany' };
}

/** Czy odczyt wygląda na kompletny numer karty (do walidacji ręcznego wpisu). */
export function looksLikeUid(raw, fmt = 'auto') {
  try {
    parseUid(raw, fmt);
    return true;
  } catch {
    return false;
  }
}
