/**
 * Strona odczytu na telefonie — serwowana przez proces główny aplikacji
 * (electron/bridge.js) w sieci lokalnej.
 *
 * Świadomie tylko wpisanie numeru. Przeglądarka na iPhonie nie ma dostępu do
 * NFC (Safari nie implementuje Web NFC), więc telefonem nie da się odczytać
 * karty zbliżeniowej ze strony internetowej — do kart służy czytnik USB
 * podłączony do komputera. Ta strona jest wygodna, gdy numer trzeba wprowadzić
 * z etykiety karty, będąc z dala od biurka.
 */

import './mobile.css';

interface ScanResponse {
  ok: boolean;
  error?: string;
  decision?: 'granted' | 'denied' | 'unknown' | 'duplicate';
  reason?: string;
  card?: { label: string; owner: string } | null;
  uid?: { pretty: string; dec10: string };
}

interface RecentRow {
  ts: string;
  uidHex: string;
  decision: string;
  label: string;
  station: string;
}

const DECISION_LABEL: Record<string, string> = {
  granted: 'Dostęp przyznany',
  denied: 'Dostęp odmówiony',
  unknown: 'Karta nieznana',
  duplicate: 'Powtórny odczyt',
};

// Sekret parowania jest ostatnim segmentem adresu; budujemy z niego pełne
// ścieżki API, bo adresy relatywne rozwiązywałyby się względem /s/.
const TOKEN = location.pathname.split('/').filter(Boolean).pop() || '';
const API = (path: string) => `/s/${TOKEN}/api/${path}`;

const app = document.getElementById('app')!;
app.innerHTML = `
  <h1>Odczyt karty</h1>
  <p class="sub">Wpisz numer z etykiety — odczyt trafi wprost do aplikacji.</p>

  <div class="stack">
    <div id="verdict" class="verdict hidden"></div>

    <form id="manual" class="card stack">
      <div class="label">Numer karty</div>
      <input id="raw" inputmode="latin" autocomplete="off" spellcheck="false"
             autocapitalize="characters" placeholder="np. 0004372425" />
      <button type="submit" class="primary">Wyślij odczyt</button>
    </form>

    <div class="card">
      <div class="label">Ostatnie odczyty</div>
      <ul class="feed" id="feed"><li>Brak odczytów.</li></ul>
    </div>

    <p class="note">
      Telefonem <strong>nie da się odczytać karty zbliżeniowej</strong> z tej strony —
      przeglądarki na iPhonie nie mają dostępu do NFC. Kartę odczytuje czytnik USB
      przy komputerze; ta strona przyjmuje numer wpisany z etykiety.
    </p>
  </div>
`;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const verdictBox = el<HTMLDivElement>('verdict');
const feed = el<HTMLUListElement>('feed');
const input = el<HTMLInputElement>('raw');
const form = el<HTMLFormElement>('manual');

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

function showVerdict(result: ScanResponse) {
  const decision = result.ok ? result.decision! : 'error';
  const who = result.ok
    ? result.card
      ? escape(result.card.label || 'Karta bez nazwy') + (result.card.owner ? ` · ${escape(result.card.owner)}` : '')
      : 'Karta nie jest w bazie'
    : '';
  verdictBox.className = `verdict verdict--${decision}`;
  verdictBox.innerHTML = `
    <div class="verdict__badge">${result.ok ? DECISION_LABEL[decision] : 'Nie rozpoznano'}</div>
    ${who ? `<div class="verdict__who">${who}</div>` : ''}
    <div class="verdict__reason">${escape(result.ok ? result.reason || '' : result.error || '')}</div>
    ${result.uid ? `<div class="verdict__uid">${escape(result.uid.pretty)}</div>` : ''}
  `;
  // Wibracja działa na Androidzie; iOS ją ignoruje, więc wynik musi być
  // czytelny również bez niej.
  navigator.vibrate?.(decision === 'granted' ? 40 : [40, 60, 40]);
}

let sending = false;

async function send(raw: string) {
  if (sending) return;
  sending = true;
  try {
    const res = await fetch(API('scan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, source: 'telefon' }),
    });
    showVerdict(await res.json());
    void loadRecent();
  } catch (err) {
    showVerdict({ ok: false, error: `Brak połączenia z aplikacją: ${(err as Error).message}` });
  } finally {
    sending = false;
  }
}

async function loadRecent() {
  try {
    const res = await fetch(API('recent'));
    const data: { rows: RecentRow[] } = await res.json();
    feed.innerHTML = data.rows.length
      ? data.rows
          .map((r) => {
            const time = new Date(r.ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
            return `<li class="${r.decision}">
              <span>${escape(r.label || r.uidHex)}</span>
              <time>${time}</time>
            </li>`;
          })
          .join('')
      : '<li>Brak odczytów.</li>';
  } catch {
    /* lista jest tylko informacyjna */
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = input.value.trim();
  if (!raw) return;
  input.value = '';
  input.blur();
  void send(raw);
});

void loadRecent();
window.setInterval(() => void loadRecent(), 10_000);
