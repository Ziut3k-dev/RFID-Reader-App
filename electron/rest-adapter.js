/**
 * Wykonawca operacji opisanych profilem REST (shared/rest-profile.js).
 *
 * Zamienia opis operacji na zapytanie HTTP: składa adres, wypełnia szablon
 * treści, dokłada token i sprawdza, czy odpowiedź jest sukcesem. Cała wiedza
 * o konkretnym API siedzi w profilu, więc ten moduł nie zna słowa „akubela”.
 *
 * Token trzymamy tylko w pamięci procesu. Zapisanie go na dysku nie dałoby nic
 * poza kolejnym miejscem, z którego może wyciec — żyje godzinę i odtwarza się
 * z poświadczeń.
 */

import crypto from 'node:crypto';
import { HttpClient, HttpError } from './http-client.js';
import { mapList, pickPath, renderBody, renderTemplate } from '../shared/rest-profile.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
/** Margines przed wygaśnięciem tokenu — lepiej odświeżyć wcześniej niż dostać 401. */
const TOKEN_MARGIN_MS = 60_000;

export class RestAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.profile      profil API
   * @param {object} opts.credentials  { clientId, clientSecret, username, password }
   * @param {HttpClient} [opts.http]
   */
  constructor({ profile, credentials = {}, http } = {}) {
    this.profile = profile;
    this.credentials = credentials;
    this.http = http || new HttpClient();
    this.token = '';
    this.refreshToken = '';
    this.tokenExpiresAt = 0;
  }

  get hasToken() {
    return Boolean(this.token) && Date.now() < this.tokenExpiresAt;
  }

  /** Identyfikator polecenia — API oczekuje 32 znaków HEX generowanych przez klienta. */
  static requestId() {
    return crypto.randomBytes(16).toString('hex');
  }

  #url(op, vars) {
    const base = String(this.profile.baseUrl || '').replace(/\/+$/, '');
    return base + renderTemplate(op.path, vars);
  }

  #authHeaders(op) {
    const auth = this.profile.auth || {};
    if (op.auth === false || auth.type === 'none') return {};
    if (auth.type === 'basic') {
      const raw = `${this.credentials.username || ''}:${this.credentials.password || ''}`;
      return { Authorization: `Basic ${Buffer.from(raw).toString('base64')}` };
    }
    if (auth.type === 'bearer') {
      return { Authorization: `Bearer ${this.credentials.token || this.token}` };
    }
    // 'header' i 'login' różnią się tylko tym, skąd bierze się wartość.
    const name = auth.headerName || 'Authorization';
    const value = `${auth.prefix || ''}${auth.type === 'header' ? (this.credentials.token || '') : this.token}`;
    return value.trim() ? { [name]: value } : {};
  }

  /** Sprawdza kopertę odpowiedzi — API zwraca błędy logiczne z kodem HTTP 200. */
  #unwrap(op, data, url) {
    const { successPath, errorPath } = this.profile;
    if (successPath) {
      const ok = pickPath(data, successPath);
      if (ok !== true && ok !== 'true' && ok !== 1) {
        const message = (errorPath && pickPath(data, errorPath))
          || pickPath(data, 'msg')
          || pickPath(data, 'error')
          || 'API zgłosiło niepowodzenie bez treści błędu';
        throw new HttpError(`${op.body?.command || op.path}: ${message}`, { status: 200, body: data, url });
      }
    }
    return data;
  }

  #vars(extra = {}) {
    return {
      requestId: RestAdapter.requestId(),
      pageSize: PAGE_SIZE,
      pageIndex: this.profile.pageStart ?? 1,
      clientId: this.credentials.clientId || '',
      clientSecret: this.credentials.clientSecret || '',
      username: this.credentials.username || '',
      password: this.credentials.password || '',
      refreshToken: this.refreshToken || '',
      ...extra,
    };
  }

  async #send(op, vars) {
    const url = this.#url(op, vars);
    const method = (op.method || 'GET').toUpperCase();
    const headers = this.#authHeaders(op);

    let body;
    if (op.body !== undefined && method !== 'GET') {
      const rendered = renderBody(op.body, vars);
      if (op.bodyType === 'form') {
        // Punkt tokenu OAuth 2.0 przyjmuje wyłącznie formularz, nie JSON.
        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(rendered)) form.set(key, String(value));
        const { data } = await this.http.request(url, {
          method,
          headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          rawBody: form.toString(),
        });
        return { data: this.#unwrap(op, data, url), url };
      }
      body = rendered;
    }

    const { data } = await this.http.request(url, { method, headers, body });
    return { data: this.#unwrap(op, data, url), url };
  }

  /** Łączność bez poświadczeń — oddziela awarię sieci od złego klucza. */
  async ping() {
    const op = this.profile.operations?.ping;
    if (!op?.path) return { ok: true, skipped: true, message: 'Profil nie ma operacji sprawdzenia łączności.' };
    const { data } = await this.#send(op, this.#vars());
    return { ok: true, data };
  }

  /** Loguje się i zapamiętuje token w pamięci procesu. */
  async login() {
    const op = this.profile.operations?.login;
    if (!op?.path) {
      // Profil z tokenem podanym wprost (auth.type === 'header') nie loguje się.
      return { ok: true, skipped: true };
    }
    const { data } = await this.#send(op, this.#vars());
    this.#storeToken(op, data);
    return { ok: true };
  }

  #storeToken(op, data) {
    const token = pickPath(data, op.tokenPath || 'access_token');
    if (!token) throw new HttpError(`Odpowiedź logowania nie zawiera tokenu pod "${op.tokenPath}"`, { status: 200, body: data });
    this.token = String(token);
    this.refreshToken = String(pickPath(data, op.refreshTokenPath || '') || this.refreshToken || '');
    const seconds = Number(pickPath(data, op.expiresPath || '')) || 3600;
    this.tokenExpiresAt = Date.now() + seconds * 1000 - TOKEN_MARGIN_MS;
  }

  async ensureToken() {
    if (this.hasToken) return;
    const refresh = this.profile.operations?.refresh;
    if (this.refreshToken && refresh?.path) {
      try {
        const { data } = await this.#send(refresh, this.#vars());
        this.#storeToken(refresh, data);
        return;
      } catch {
        // Odświeżenie potrafi odmówić po unieważnieniu sesji — wtedy pełne logowanie.
        this.refreshToken = '';
      }
    }
    await this.login();
  }

  /**
   * Wykonuje operację z profilu. Przy odpowiedzi 401 raz odświeża token
   * i powtarza — wygaśnięcie w trakcie pracy jest normalne, nie awarią.
   */
  async run(name, extra = {}) {
    const op = this.profile.operations?.[name];
    if (!op?.path) throw new Error(`Profil nie opisuje operacji "${name}"`);
    if (op.auth !== false) await this.ensureToken();

    try {
      return await this.#send(op, this.#vars(extra));
    } catch (err) {
      if (err instanceof HttpError && err.status === 401 && op.auth !== false) {
        this.token = '';
        await this.ensureToken();
        return this.#send(op, this.#vars(extra));
      }
      throw err;
    }
  }

  /** Operacja zwracająca listę, z przejściem po stronach. */
  async list(name, extra = {}) {
    const op = this.profile.operations?.[name];
    if (!op?.path) throw new Error(`Profil nie opisuje operacji "${name}"`);

    const items = [];
    const start = this.profile.pageStart ?? 1;
    for (let page = start; page < start + MAX_PAGES; page += 1) {
      const { data } = await this.run(name, { ...extra, pageIndex: page, pageSize: PAGE_SIZE });
      const batch = mapList(data, op);
      items.push(...batch);
      // API nie zwraca liczby wszystkich rekordów, więc kończymy na krótszej stronie.
      if (batch.length < PAGE_SIZE) break;
    }
    return items;
  }

  /** Identyfikator nadany przez system zewnętrzny po zapisie. */
  static remoteIdFrom(op, data) {
    return op.remoteIdPath ? String(pickPath(data, op.remoteIdPath) ?? '') : '';
  }
}
