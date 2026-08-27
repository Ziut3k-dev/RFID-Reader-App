/**
 * Klient HTTP dla integracji z chmurą: limit czasu, ponawianie i dziennik
 * zapytań do diagnostyki.
 *
 * Osobny moduł, bo integracja z zewnętrznym API zawodzi inaczej niż lokalny
 * odczyt karty: chwilowy 502, wygasły token, limit zapytań. Bez ponawiania
 * i bez wglądu w to, co poszło na drut, dostrajanie integracji jest zgadywaniem.
 *
 * Dziennik trzyma nagłówki i treści z zamaskowanymi sekretami — ma pomagać
 * w diagnozie, a nie tworzyć drugiego miejsca, gdzie wyciekają klucze API.
 */

const SECRET_HEADERS = ['authorization', 'x-api-key', 'x-auth-token', 'token', 'cookie'];

/**
 * Nazwy pól z sekretami. Rozpoznajemy po fragmencie, a nie po pełnej nazwie:
 * lista dokładnych nazw zawsze będzie niepełna (apiSecret, clientSecret,
 * accessKeyId, x_app_token…), a przeoczenie oznacza klucz w dzienniku.
 * Nadmiarowe zamaskowanie jest tu tanie, przeoczenie — nie.
 */
const SECRET_SUBSTRINGS = [
  'password', 'passwd', 'secret', 'apikey', 'appkey', 'accesskey', 'privatekey',
  'token', 'credential', 'signature', 'authorization', 'cookie', 'bearer',
];

/** Krótkie i wieloznaczne nazwy dopasowujemy dokładnie, żeby nie maskować
 *  pól w rodzaju "assignee" (zawiera "sign") czy "keyboard". */
const SECRET_EXACT = new Set(['pin', 'sign', 'key', 'auth', 'pwd', 'pass', 'hash', 'salt']);

function isSecretField(name) {
  const normalized = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SECRET_EXACT.has(normalized)) return true;
  return SECRET_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

/** Zamienia wartość sekretu na skrót, żeby dziennik pozostał użyteczny. */
function mask(value) {
  const text = String(value ?? '');
  if (text.length <= 8) return '***';
  return `${text.slice(0, 4)}…${text.slice(-2)} (${text.length} znaków)`;
}

export { isSecretField };

export function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.includes(key.toLowerCase()) ? mask(value) : value;
  }
  return out;
}

export function redactBody(body) {
  if (body === null || body === undefined) return body;
  if (Array.isArray(body)) return body.map(redactBody);
  if (typeof body === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(body)) {
      out[key] = isSecretField(key) ? mask(value) : redactBody(value);
    }
    return out;
  }
  return body;
}

export class HttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status ?? 0;
    this.body = body;
    this.url = url;
  }
}

export class HttpClient {
  /**
   * @param {object} opts
   * @param {number} [opts.timeoutMs]     limit czasu jednego zapytania
   * @param {number} [opts.retries]       liczba ponowień przy błędach przejściowych
   * @param {number} [opts.logSize]       ile ostatnich zapytań pamiętać
   * @param {boolean} [opts.dryRun]       nie wysyłaj — tylko zapisz zapytanie w dzienniku
   * @param {(entry: object) => void} [opts.onLog]
   */
  constructor({ timeoutMs = 12_000, retries = 2, logSize = 50, dryRun = false, onLog } = {}) {
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logSize = logSize;
    this.dryRun = dryRun;
    this.onLog = onLog;
    this.log = [];
  }

  /** Ponawiamy tylko to, co ma sens ponawiać — nie 400 ani 401. */
  static retriable(status) {
    return status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);
  }

  #record(entry) {
    this.log.unshift(entry);
    if (this.log.length > this.logSize) this.log.length = this.logSize;
    this.onLog?.(entry);
  }

  /**
   * @param {string} url
   * @param {object} [opts] { method, headers, body, expectJson }
   * @returns {Promise<{status: number, data: any, text: string}>}
   */
  async request(url, { method = 'GET', headers = {}, body, expectJson = true } = {}) {
    const startedAt = new Date().toISOString();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const entry = {
      at: startedAt,
      method,
      url,
      headers: redactHeaders(headers),
      body: redactBody(body),
      dryRun: this.dryRun,
      attempts: 0,
      status: null,
      ms: 0,
      error: null,
      response: null,
    };

    if (this.dryRun) {
      // Tryb podglądu: pokazujemy, co poszłoby na drut, bez wysyłania.
      entry.status = 0;
      entry.error = 'tryb podglądu — zapytanie nie zostało wysłane';
      this.#record(entry);
      return { status: 0, data: null, text: '', dryRun: true };
    }

    let lastError = null;
    for (let attempt = 1; attempt <= this.retries + 1; attempt += 1) {
      entry.attempts = attempt;
      const began = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers: payload ? { 'Content-Type': 'application/json', ...headers } : headers,
          body: payload,
          signal: controller.signal,
          redirect: 'follow',
        });
        clearTimeout(timer);
        entry.ms = Date.now() - began;
        entry.status = response.status;

        const text = await response.text();
        let data = null;
        if (expectJson && text) {
          try { data = JSON.parse(text); } catch { data = null; }
        }
        entry.response = data ? redactBody(data) : text.slice(0, 600);

        if (!response.ok) {
          const error = new HttpError(
            `${method} ${url} zwróciło ${response.status}`,
            { status: response.status, body: data ?? text, url },
          );
          if (HttpClient.retriable(response.status) && attempt <= this.retries) {
            lastError = error;
            // Odczekanie rośnie wykładniczo; serwer z limitem zapytań
            // potrzebuje przerwy, nie kolejnego natychmiastowego strzału.
            await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
            continue;
          }
          entry.error = error.message;
          this.#record(entry);
          throw error;
        }

        this.#record(entry);
        return { status: response.status, data, text };
      } catch (err) {
        clearTimeout(timer);
        entry.ms = Date.now() - began;
        if (err instanceof HttpError) throw err;

        const message = err.name === 'AbortError'
          ? `przekroczono limit czasu (${this.timeoutMs} ms)`
          : err.message;
        lastError = new HttpError(`${method} ${url}: ${message}`, { status: 0, url });

        if (attempt <= this.retries) {
          await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
          continue;
        }
        entry.error = lastError.message;
        this.#record(entry);
        throw lastError;
      }
    }

    entry.error = lastError?.message ?? 'nieznany błąd';
    this.#record(entry);
    throw lastError ?? new HttpError(`${method} ${url}: nieznany błąd`, { url });
  }

  recentLog() {
    return this.log;
  }
}
