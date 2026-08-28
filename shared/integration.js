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
   */
  async assign(cardId, target) {
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
      siteId: String(target.siteId),
      siteName: target.siteName || '',
      apartmentId: String(target.apartmentId),
      apartmentName: target.apartmentName || '',
      residentId: String(target.residentId),
      residentName: target.residentName || '',
      state: 'pending',
      error: '',
    });

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

      const updated = this.store.setCardLink(cardId, {
        remoteId,
        state: 'synced',
        syncedAt: new Date().toISOString(),
        error: '',
      });
      return { ok: true, card: updated, cardNumber, remoteId };
    } catch (err) {
      const updated = this.store.setCardLink(cardId, { state: 'error', error: err.message });
      return { ok: false, card: updated, cardNumber, error: err.message };
    }
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

  /** Ponawia karty, które nie doszły do chmury. */
  async retryPending() {
    const cards = this.store.listUnsyncedCards();
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
        })),
      });
    }
    return { total: cards.length, ok: results.filter((r) => r.ok).length, results };
  }
}
