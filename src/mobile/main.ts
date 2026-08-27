/**
 * Skaner na telefonie — strona serwowana przez proces główny aplikacji
 * (electron/bridge.js) w sieci lokalnej.
 *
 * Dwie drogi odczytu, bo przeglądarki różnie ograniczają dostęp do kamery:
 *
 *  1. Podgląd na żywo (`getUserMedia`) — wymaga bezpiecznego kontekstu, więc
 *     przez zwykłe http:// w sieci lokalnej Safari na iOS go nie udostępni.
 *     Działa na Androidzie i po ustawieniu HTTPS.
 *  2. Zdjęcie z kamery systemowej (`<input capture>`) — nie podlega temu
 *     ograniczeniu i działa na iPhonie przez http://. Jedno zdjęcie na odczyt.
 *
 * Kod QR dekodujemy w przeglądarce (jsQR), więc zdjęcie nie opuszcza telefonu —
 * do aplikacji leci wyłącznie odczytany numer.
 *
 * Kart RFID ta strona nie odczyta: Safari nie ma Web NFC. Do kart zbliżeniowych
 * służy czytnik USB podłączony do komputera.
 */

import jsQR from 'jsqr';
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

const liveSupported = Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;

const app = document.getElementById('app')!;
app.innerHTML = `
  <h1>Skaner RFID</h1>
  <p class="sub">Telefon jako skaner kodów — odczyty trafiają wprost do aplikacji.</p>

  <div class="stack">
    <div id="verdict" class="verdict hidden"></div>

    <div class="camera hidden" id="camera">
      <video id="video" playsinline muted></video>
      <div class="camera__frame"></div>
      <div class="camera__hint">Skieruj kamerę na kod</div>
    </div>

    <button id="live" class="primary ${liveSupported ? '' : 'hidden'}">Skanuj kamerą na żywo</button>

    <button id="photo" class="${liveSupported ? '' : 'primary'}">Zrób zdjęcie kodu</button>
    <input id="file" class="hidden" type="file" accept="image/*" capture="environment" />

    <div class="card">
      <div class="label">Numer z etykiety</div>
      <form id="manual" class="stack">
        <input id="raw" inputmode="latin" autocomplete="off" spellcheck="false"
               placeholder="np. 0004372425" />
        <button type="submit">Wyślij odczyt</button>
      </form>
    </div>

    <div class="card">
      <div class="label">Ostatnie odczyty</div>
      <ul class="feed" id="feed"><li>Brak odczytów.</li></ul>
    </div>

    <p class="note">
      Ta strona skanuje <strong>kody QR i kreskowe</strong> kamerą telefonu.
      Kart zbliżeniowych 13,56 MHz nie odczyta — przeglądarki na iPhonie nie mają
      dostępu do NFC, więc do samych kart służy czytnik USB przy komputerze.
    </p>
  </div>
`;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const verdictBox = el<HTMLDivElement>('verdict');
const cameraBox = el<HTMLDivElement>('camera');
const video = el<HTMLVideoElement>('video');
const liveButton = el<HTMLButtonElement>('live');
const photoButton = el<HTMLButtonElement>('photo');
const fileInput = el<HTMLInputElement>('file');
const feed = el<HTMLUListElement>('feed');

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
let lastCode = '';
let lastCodeAt = 0;

async function send(raw: string, source: 'telefon' | 'kamera') {
  if (sending) return;
  // Ten sam kod w kadrze przez kilka klatek nie ma sensu wysyłać wielokrotnie.
  const now = Date.now();
  if (raw === lastCode && now - lastCodeAt < 2500) return;
  lastCode = raw;
  lastCodeAt = now;

  sending = true;
  try {
    const res = await fetch(API('scan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, source }),
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

/** Dekoduje kod z obrazu; zwraca treść albo null. */
function decode(source: HTMLVideoElement | HTMLImageElement, width: number, height: number): string | null {
  if (!width || !height) return null;
  // Duże zdjęcia z telefonu skalujemy — jsQR liczy po pikselach, a 12 Mpx
  // zajęłoby sekundy.
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  return jsQR(image.data, w, h, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

// --- podgląd na żywo --------------------------------------------------------

let stream: MediaStream | null = null;
let loop = 0;

async function startLive() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } },
      audio: false,
    });
  } catch (err) {
    showVerdict({ ok: false, error: `Brak dostępu do kamery: ${(err as Error).message}. Użyj zdjęcia albo wpisz numer.` });
    return;
  }
  video.srcObject = stream;
  await video.play();
  cameraBox.classList.remove('hidden');
  liveButton.textContent = 'Zatrzymaj kamerę';
  liveButton.classList.add('danger');
  liveButton.classList.remove('primary');

  const tick = () => {
    if (!stream) return;
    const code = decode(video, video.videoWidth, video.videoHeight);
    if (code) void send(code, 'kamera');
    loop = requestAnimationFrame(tick);
  };
  loop = requestAnimationFrame(tick);
}

function stopLive() {
  cancelAnimationFrame(loop);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  cameraBox.classList.add('hidden');
  liveButton.textContent = 'Skanuj kamerą na żywo';
  liveButton.classList.add('primary');
  liveButton.classList.remove('danger');
}

liveButton.addEventListener('click', () => (stream ? stopLive() : void startLive()));

// --- zdjęcie z kamery systemowej -------------------------------------------

photoButton.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;

  photoButton.disabled = true;
  photoButton.textContent = 'Odczytywanie…';
  try {
    const url = URL.createObjectURL(file);
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('nie udało się wczytać zdjęcia'));
      image.src = url;
    });
    const code = decode(image, image.naturalWidth, image.naturalHeight);
    URL.revokeObjectURL(url);
    if (code) {
      await send(code, 'kamera');
    } else {
      showVerdict({ ok: false, error: 'Nie znaleziono kodu na zdjęciu. Ustaw kod w kadrze i spróbuj ponownie.' });
    }
  } catch (err) {
    showVerdict({ ok: false, error: (err as Error).message });
  } finally {
    photoButton.disabled = false;
    photoButton.textContent = 'Zrób zdjęcie kodu';
  }
});

// --- wpisanie numeru z etykiety --------------------------------------------

el<HTMLFormElement>('manual').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = el<HTMLInputElement>('raw');
  const raw = input.value.trim();
  if (!raw) return;
  input.value = '';
  input.blur();
  // Ręczny wpis nie podlega blokadzie powtórzeń z podglądu kamery.
  lastCode = '';
  void send(raw, 'telefon');
});

void loadRecent();
window.setInterval(() => { if (!stream) void loadRecent(); }, 10_000);
