/**
 * Warstwa łącząca reguły (shared/core.js) z magazynem danych (store.js).
 * Cała logika decyzji o dostępie żyje tutaj, a proces renderujący dostaje
 * gotowy wynik przez IPC.
 */

import { parseUid, lookupKeys, evaluate, DECISION, UidError } from './core.js';

export class ScanService {
  constructor(store) {
    this.store = store;
  }

  /**
   * Przetwarza jeden odczyt czytnika.
   * @param {string} raw   dokładnie to, co "wpisał" czytnik
   * @param {object} opts  { station }
   */
  processScan(raw, opts = {}) {
    const settings = this.store.getSettings();
    let uid;
    try {
      uid = parseUid(raw, settings.uidFormat);
    } catch (err) {
      if (err instanceof UidError) {
        return { ok: false, error: err.message, raw: String(raw ?? '') };
      }
      throw err;
    }

    const keys = lookupKeys(uid);
    let card = this.store.findCardByKeys(keys);
    const lastScanTs = this.store.lastScanTs(keys);
    const now = new Date();

    let { decision, reason } = evaluate({ card, now, settings, lastScanTs });

    // Tryb nauki: nieznana karta trafia od razu do bazy.
    if (decision === DECISION.UNKNOWN && settings.unknownPolicy === 'enroll') {
      card = this.store.createCard({
        uidHex: uid.hex,
        uidDec: uid.dec10,
        bytes: uid.bytes,
        label: '',
        note: 'dopisana automatycznie przy pierwszym odczycie',
      });
      decision = DECISION.GRANTED;
      reason = 'karta dopisana automatycznie';
    }

    // Odczyt odrzucony przez debounce nie zaśmieca historii — to jego cel.
    // Dopasowanej karcie przypisujemy jej kanoniczny numer, bo ten sam czytnik
    // może przysłać UID w odwróconej kolejności bajtów; surowy odczyt zostaje
    // w polu uidRaw, a historia i statystyki widzą jedną kartę, nie dwie.
    const scan = decision === DECISION.DUPLICATE
      ? null
      : this.store.addScan({
          ts: now.toISOString(),
          uidHex: card ? card.uidHex : uid.hex,
          uidRaw: uid.raw,
          cardId: card ? card.id : null,
          decision,
          reason,
          station: opts.station || settings.station,
        });

    return {
      ok: true,
      uid,
      card: card ? { ...card, scanCount: this.store.countScans(card.id) } : null,
      decision,
      reason,
      scan,
      at: now.toISOString(),
    };
  }

  /** Zapisuje kartę na podstawie odczytu (przycisk „Dopisz kartę”). */
  enroll(input) {
    const settings = this.store.getSettings();
    const uid = parseUid(input.uid ?? input.uidHex, input.uid ? settings.uidFormat : 'hex');
    const card = this.store.createCard({
      uidHex: uid.hex,
      uidDec: uid.dec10,
      bytes: uid.bytes,
      label: input.label,
      owner: input.owner,
      role: input.role,
      active: input.active,
      validFrom: input.validFrom,
      validTo: input.validTo,
      note: input.note,
    });

    // Odczyt, który zainicjował zapis, dostaje wsteczne powiązanie z kartą,
    // żeby historia nie pokazywała "nieznana karta" dla świeżo dodanej osoby.
    const keys = lookupKeys(uid);
    for (let i = this.store.data.scans.length - 1; i >= 0; i -= 1) {
      const scan = this.store.data.scans[i];
      if (!keys.includes(scan.uidHex)) continue;
      if (scan.decision !== DECISION.UNKNOWN) break;
      scan.cardId = card.id;
      scan.decision = DECISION.GRANTED;
      scan.reason = 'karta dopisana do bazy';
      break;
    }
    this.store.save();
    return card;
  }

  /** Podgląd wszystkich reprezentacji numeru — używany przez diagnostykę. */
  inspect(raw) {
    const settings = this.store.getSettings();
    const result = { raw: String(raw ?? '') };
    for (const fmt of ['auto', 'dec', 'hex']) {
      try {
        result[fmt] = parseUid(raw, fmt);
      } catch (err) {
        result[fmt] = { error: err.message };
      }
    }
    result.activeFormat = settings.uidFormat;
    return result;
  }
}
