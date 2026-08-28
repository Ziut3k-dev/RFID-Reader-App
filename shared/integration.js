/**
 * Usługa integracji: łączy bazę kart z zewnętrznym systemem opisanym profilem.
 *
 * Trzyma się dwóch zasad:
 *
 * 1. Baza lokalna jest źródłem prawdy o odczytach, a chmura o uprawnieniach.
 *    Przypisanie karty zapisujemy najpierw lokalnie ze stanem „pending”, potem
 *    wysyłamy. Gdy wysyłka padnie, karta zostaje ze stanem „error” i konkretnym
 *    powodem — nie znika i nie udaje, że wszystko się udało.
 * 2. Nic nie działa po cichu. Każda nieudana operacja ma powód zapisany przy
 *    karcie, a ponowienie jest jawnym działaniem użytkownika albo kolejki.
 */

import { parseUid } from './core.js';
import { toCsv } from './store.js';

/** Numer karty w postaci, jakiej oczekuje zewnętrzne API. */
export function cardNumberFor(card, format = 'dec') {
  const uid = parseUid(card.uidHex, 'hex');
  switch (format) {
    case 'dec': return uid.dec;
    case 'dec10': return uid.dec10;
    case 'hex': return uid.hex;
    case 'hexReversed': return uid.hexReversed;
    default: throw new Error(`Nieznany format numeru karty: ${format}`);
  }
}

export class IntegrationService {
  /**
   * @param {object} opts
   * @param {import('./store.js').Store} opts.store
   * @param {() => object} opts.adapter  funkcja zwracająca gotowy adapter
   *   (wstrzykiwana, żeby ten moduł nie zależał od warstwy HTTP ani Electrona)
   */
  constructor({ store, adapter }) {
    this.store = store;
    this.getAdapter = adapter;
  }

  get profile() {
    return this.getAdapter().profile;
  }

  /** Sprawdzenie połączenia: najpierw sieć, potem poświadczenia. */
  async test() {
    const adapter = this.getAdapter();
    const steps = [];
    try {
      const ping = await adapter.ping();
      steps.push({ step: 'łączność', ok: true, detail: ping.skipped ? 'pominięto' : 'serwer odpowiada' });
    } catch (err) {
      steps.push({ step: 'łączność', ok: false, detail: err.message });
      return { ok: false, steps };
    }
    try {
      await adapter.login();
      steps.push({ step: 'poświadczenia', ok: true, detail: 'token uzyskany' });
    } catch (err) {
      steps.push({ step: 'poświadczenia', ok: false, detail: err.message });
      return { ok: false, steps };
    }
    try {
      const sites = await adapter.list('sites');
      steps.push({
        step: 'obiekty',
        ok: true,
        detail: sites.length ? `widoczne obiekty: ${sites.length}` : 'połączono, ale konto nie widzi żadnego obiektu',
      });
      return { ok: true, steps, sites };
    } catch (err) {
      steps.push({ step: 'obiekty', ok: false, detail: err.message });
      return { ok: false, steps };
    }
  }

  /**
   * Ostrzeżenia przed przypisaniem. Nie blokują — instalator czasem świadomie
   * wydaje drugą kartę do mieszkania — ale muszą być widoczne, bo cicho nadpisana
   * karta to telefon od klienta za dwa tygodnie.
   */
  async checkAssign(cardId, target) {
    const card = this.store.getCard(cardId);
    if (!card) throw new Error(`Nie ma karty o id ${cardId}`);
    const warnings = [];

    if (card.link.provider && card.link.state !== 'none') {
      warnings.push({
        code: 'karta-juz-przypisana',
        text: `Ta karta jest już przypisana: ${card.link.residentName || card.link.residentId}`
          + `${card.link.apartmentName ? `, ${card.link.apartmentName}` : ''}`
          + `${card.link.siteName ? ` (${card.link.siteName})` : ''}.`,
      });
    }

    // Inna karta wydana temu samemu mieszkańcowi w tym samym obiekcie.
    const sameResident = this.store.listCards().filter((c) => (
      c.id !== cardId
      && c.link.provider
      && c.link.residentId === String(target.residentId)
      && c.link.siteId === String(target.siteId)
    ));
    if (sameResident.length) {
      warnings.push({
        code: 'mieszkaniec-ma-karte',
        text: `Ten mieszkaniec ma już ${sameResident.length === 1 ? 'kartę' : `${sameResident.length} karty`}: `
          + sameResident.map((c) => c.label || c.uidHex).join(', ') + '.',
      });
    }

    // Numer widziany po stronie chmury — wyłapuje kartę wydaną poza aplikacją.
    try {
      const number = cardNumberFor(card, this.profile.cardFormat);
      const remote = await this.residentCards(target);
      if (remote.some((r) => String(r.name) === number)) {
        warnings.push({
          code: 'numer-juz-w-chmurze',
          text: `Numer ${number} jest już zapisany u tego mieszkańca w chmurze.`,
        });
      }
    } catch {
      // Brak łączności nie może blokować sprawdzenia lokalnego.
      warnings.push({ code: 'brak-sprawdzenia-w-chmurze', text: 'Nie udało się sprawdzić kart tego mieszkańca w chmurze.' });
    }

    return warnings;
  }

  sites() {
    return this.getAdapter().list('sites');
  }

  buildings(siteId) {
    return this.getAdapter().list('buildings', { siteId });
  }

  apartments(siteId) {
    return this.getAdapter().list('apartments', { siteId });
  }

  /**
   * Mieszkańcy obiektu. To API nie umie filtrować po mieszkaniu, dlatego
   * zawężamy listę po stronie aplikacji na podstawie pola dodatkowego
   * (u Akuvoxa: residence_id przy każdym koncie).
   */
  async residents(siteId, apartmentId = '') {
    const all = await this.getAdapter().list('residents', { siteId });
    if (!apartmentId) return all;
    const filtered = all.filter((r) => String(r.extra ?? '') === String(apartmentId));
    // Gdy API nie zwraca pola dodatkowego, filtr wyciąłby wszystko —
    // lepiej pokazać pełną listę niż puste okno wyboru.
    return filtered.length || all.every((r) => r.extra !== undefined) ? filtered : all;
  }

  /** Poświadczenia mieszkańca już zapisane w chmurze (do sprawdzenia duplikatu). */
  async residentCards(target) {
    const op = this.profile.operations?.residentAccess;
    if (!op?.path) return [];
    return this.getAdapter().list('residentAccess', target);
  }

  /**
   * Przypisuje kartę mieszkańcowi.
   * @param {number} cardId
   * @param {object} target { siteId, siteName, apartmentId, apartmentName, residentId, residentName }
   * @param {object} [opts] { installerName, connectionId, offline, verify, replacesCardId, replacementReason }
   */
  async assign(cardId, target, opts = {}) {
    const card = this.store.getCard(cardId);
    if (!card) throw new Error(`Nie ma karty o id ${cardId}`);
    for (const field of ['siteId', 'apartmentId', 'residentId']) {
      if (!target?.[field]) throw new Error(`Brak wartości "${field}" — wybierz obiekt, mieszkanie i mieszkańca.`);
    }

    const provider = this.profile.providerId || 'akuvox';
    const cardNumber = cardNumberFor(card, this.profile.cardFormat);

    // Stan „pending” zapisujemy przed wysyłką: gdy aplikacja padnie w trakcie,
    // po uruchomieniu widać, że przypisanie nie zostało potwierdzone.
    this.store.setCardLink(cardId, {
      provider,
      connectionId: opts.connectionId || '',
      siteId: String(target.siteId),
      siteName: target.siteName || '',
      apartmentId: String(target.apartmentId),
      apartmentName: target.apartmentName || '',
      residentId: String(target.residentId),
      residentName: target.residentName || '',
      state: 'pending',
      error: '',
      verified: false,
      verifiedAt: '',
      assignedBy: opts.installerName || '',
      ...(opts.replacesCardId ? { replacesCardId: opts.replacesCardId } : {}),
      ...(opts.replacementReason ? { replacementReason: opts.replacementReason } : {}),
    });

    // Tryb offline: zbieramy przypisania na budowie bez zasięgu i wysyłamy
    // później. Próba wysyłki bez sieci to kilkanaście sekund na limit czasu
    // przy każdej karcie.
    if (opts.offline) {
      return { ok: true, queued: true, card: this.store.getCard(cardId), cardNumber };
    }

    try {
      const adapter = this.getAdapter();
      const op = this.profile.operations.assignCard;
      const { data } = await adapter.run('assignCard', {
        siteId: target.siteId,
        apartmentId: target.apartmentId,
        residentId: target.residentId,
        cardNumber,
      });
      const remoteId = adapter.constructor.remoteIdFrom(op, data);

      this.store.setCardLink(cardId, {
        remoteId,
        state: 'synced',
        syncedAt: new Date().toISOString(),
        error: '',
      });

      // Potwierdzenie odczytem. Odpowiedź „success” mówi, że chmura przyjęła
      // polecenie — nie że karta jest widoczna u mieszkańca. Przy przekazaniu
      // obiektu klientowi ta różnica bywa kosztowna.
      let verification = null;
      if (opts.verify !== false) {
        verification = await this.verify(cardId);
      }

      return {
        ok: true,
        card: this.store.getCard(cardId),
        cardNumber,
        remoteId,
        verified: verification ? verification.verified : undefined,
        verifyError: verification?.error,
      };
    } catch (err) {
      const updated = this.store.setCardLink(cardId, { state: 'error', error: err.message });
      return { ok: false, card: updated, cardNumber, error: err.message };
    }
  }

  /**
   * Sprawdza odczytem, czy karta faktycznie jest u mieszkańca w chmurze.
   * Brak potwierdzenia nie kasuje przypisania — odnotowuje, że nie potwierdzono.
   */
  async verify(cardId) {
    const card = this.store.getCard(cardId);
    if (!card) throw new Error(`Nie ma karty o id ${cardId}`);
    const link = card.link;
    if (!link.provider) return { verified: false, error: 'Karta nie jest przypisana.' };

    const number = cardNumberFor(card, this.profile.cardFormat);
    try {
      const remote = await this.residentCards({
        siteId: link.siteId,
        apartmentId: link.apartmentId,
        residentId: link.residentId,
      });
      const found = remote.some((r) => String(r.name) === number || String(r.id) === link.remoteId);
      this.store.setCardLink(cardId, {
        verified: found,
        verifiedAt: new Date().toISOString(),
        ...(found ? {} : { error: 'Chmura przyjęła zapis, ale karty nie widać u mieszkańca.' }),
      });
      return { verified: found, number, remoteCount: remote.length };
    } catch (err) {
      this.store.setCardLink(cardId, { verified: false, verifiedAt: '' });
      return { verified: false, error: err.message };
    }
  }

  /**
   * Wymiana zgubionej karty: odbiera starą, wydaje nową temu samemu
   * mieszkańcowi i zapisuje powód. Jedno działanie, bo rozbite na trzy kroki
   * kończy się kartą odebraną i nową niewydaną.
   */
  async replaceCard(oldCardId, newCardId, reason, opts = {}) {
    const oldCard = this.store.getCard(oldCardId);
    const newCard = this.store.getCard(newCardId);
    if (!oldCard) throw new Error(`Nie ma karty o id ${oldCardId}`);
    if (!newCard) throw new Error(`Nie ma karty o id ${newCardId}`);
    if (oldCardId === newCardId) throw new Error('Karta zastępowana i nowa to ta sama karta.');

    const link = oldCard.link;
    if (!link.provider || !link.residentId) {
      throw new Error('Stara karta nie jest przypisana do mieszkańca — użyj zwykłego przypisania.');
    }
    const target = {
      siteId: link.siteId,
      siteName: link.siteName,
      apartmentId: link.apartmentId,
      apartmentName: link.apartmentName,
      residentId: link.residentId,
      residentName: link.residentName,
    };

    const removal = await this.unassign(oldCardId);
    if (!removal.ok) {
      return { ok: false, stage: 'odebranie', error: removal.error };
    }

    // Zgubiona karta zostaje w bazie jako zablokowana: jeśli ktoś ją znajdzie
    // i użyje, w historii ma się pokazać odmowa, a nie brak wpisu.
    this.store.updateCard(oldCardId, {
      active: false,
      note: [oldCard.note, `Zgubiona/wymieniona ${new Date().toISOString().slice(0, 10)}: ${reason || 'bez powodu'}`]
        .filter(Boolean).join(' | '),
    });

    const assignment = await this.assign(newCardId, target, {
      ...opts,
      replacesCardId: oldCardId,
      replacementReason: reason || '',
    });

    return {
      ok: assignment.ok,
      stage: assignment.ok ? 'gotowe' : 'wydanie-nowej',
      removedLocalOnly: Boolean(removal.localOnly),
      target,
      assignment,
    };
  }

  /** Odbiera kartę mieszkańcowi w chmurze i czyści powiązanie lokalnie. */
  async unassign(cardId) {
    const card = this.store.getCard(cardId);
    if (!card) throw new Error(`Nie ma karty o id ${cardId}`);
    const link = card.link;
    if (!link.provider) return { ok: true, card, skipped: true };

    const op = this.profile.operations?.unassignCard;
    if (!op?.path || !link.remoteId) {
      // Bez identyfikatora zdalnego albo bez operacji nie ma czego usuwać
      // w chmurze — czyścimy tylko powiązanie lokalne i mówimy o tym wprost.
      this.store.setCardLink(cardId, { provider: '', state: 'none', remoteId: '', error: '' });
      return {
        ok: true,
        localOnly: true,
        message: link.remoteId
          ? 'Profil nie opisuje odebrania karty — powiązanie usunięto tylko lokalnie.'
          : 'Karta nie miała identyfikatora w chmurze — powiązanie usunięto tylko lokalnie.',
      };
    }

    this.store.setCardLink(cardId, { state: 'removing', error: '' });
    try {
      await this.getAdapter().run('unassignCard', {
        siteId: link.siteId,
        apartmentId: link.apartmentId,
        residentId: link.residentId,
        remoteId: link.remoteId,
      });
      this.store.setCardLink(cardId, { provider: '', state: 'none', remoteId: '', siteId: '', siteName: '', apartmentId: '', apartmentName: '', residentId: '', residentName: '', error: '', syncedAt: '' });
      return { ok: true };
    } catch (err) {
      this.store.setCardLink(cardId, { state: 'error', error: err.message });
      return { ok: false, error: err.message };
    }
  }

  /**
   * Ponawia karty, które nie doszły do chmury.
   * @param {object} [opts] { installerName, connectionId, onlyConnection }
   */
  async retryPending(opts = {}) {
    let cards = this.store.listUnsyncedCards();
    if (opts.onlyConnection) {
      cards = cards.filter((c) => c.link.connectionId === opts.onlyConnection);
    }
    const results = [];
    for (const card of cards) {
      const link = card.link;
      if (link.state === 'removing') {
        results.push({ cardId: card.id, ...(await this.unassign(card.id)) });
        continue;
      }
      results.push({
        cardId: card.id,
        ...(await this.assign(card.id, {
          siteId: link.siteId,
          siteName: link.siteName,
          apartmentId: link.apartmentId,
          apartmentName: link.apartmentName,
          residentId: link.residentId,
          residentName: link.residentName,
        }, {
          connectionId: link.connectionId,
          installerName: link.assignedBy || opts.installerName,
          replacesCardId: link.replacesCardId,
          replacementReason: link.replacementReason,
        })),
      });
    }
    return { total: cards.length, ok: results.filter((r) => r.ok).length, results };
  }
}

/**
 * Protokół przekazania kart — wiersze do wydruku i do CSV.
 *
 * Instalator oddaje obiekt z papierem: która karta trafiła do którego
 * mieszkania i do kogo. Bez tego zestawienia trzeba je składać ręcznie
 * z panelu chmury i z pamięci.
 */
export function handoverRows(store, { connectionId = '', siteId = '', cardFormat = 'dec' } = {}) {
  return store.listCards()
    .filter((c) => c.link.provider)
    .filter((c) => (connectionId ? c.link.connectionId === connectionId : true))
    .filter((c) => (siteId ? c.link.siteId === String(siteId) : true))
    .sort((a, b) => (a.link.apartmentName || '').localeCompare(b.link.apartmentName || '', 'pl')
      || (a.link.residentName || '').localeCompare(b.link.residentName || '', 'pl'))
    .map((c) => ({
      obiekt: c.link.siteName || c.link.siteId,
      mieszkanie: c.link.apartmentName || c.link.apartmentId,
      mieszkaniec: c.link.residentName || c.link.residentId,
      karta: c.label || '',
      uid: c.link.state === 'none' ? c.uidHex : c.uidHex,
      numer: safeNumber(c, cardFormat),
      stan: describeState(c.link),
      wydal: c.link.assignedBy || '',
      data: (c.link.syncedAt || c.updatedAt || '').slice(0, 19).replace('T', ' '),
      uwagi: [
        c.link.replacesCardId ? `wymiana karty #${c.link.replacesCardId}` : '',
        c.link.replacementReason,
        c.link.error,
      ].filter(Boolean).join('; '),
    }));
}

function safeNumber(card, format) {
  try {
    return cardNumberFor(card, format);
  } catch {
    return card.uidHex;
  }
}

function describeState(link) {
  if (link.state === 'synced') return link.verified ? 'w chmurze, potwierdzona' : 'w chmurze, niepotwierdzona';
  if (link.state === 'pending') return 'oczekuje na wysłanie';
  if (link.state === 'error') return 'błąd';
  if (link.state === 'removing') return 'w trakcie odbierania';
  return link.state;
}

export function handoverCsv(store, options = {}) {
  const rows = handoverRows(store, options);
  const head = ['obiekt', 'mieszkanie', 'mieszkaniec', 'karta', 'uid', 'numer', 'stan', 'wydal', 'data', 'uwagi'];
  return toCsv(head, rows.map((r) => head.map((key) => r[key])));
}
