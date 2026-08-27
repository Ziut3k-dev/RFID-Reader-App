/**
 * Krótkie sygnały dźwiękowe generowane przez WebAudio — bez plików z zasobami.
 * Kioskowe stanowisko rzadko ma ekran w polu widzenia, a dźwięk od razu mówi,
 * czy karta przeszła.
 */

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, start: number, duration: number, gain = 0.06) {
  const audio = context();
  if (!audio) return;
  const osc = audio.createOscillator();
  const vol = audio.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  vol.gain.setValueAtTime(0, audio.currentTime + start);
  vol.gain.linearRampToValueAtTime(gain, audio.currentTime + start + 0.01);
  vol.gain.linearRampToValueAtTime(0, audio.currentTime + start + duration);
  osc.connect(vol).connect(audio.destination);
  osc.start(audio.currentTime + start);
  osc.stop(audio.currentTime + start + duration + 0.02);
}

export function playFeedback(decision: string) {
  switch (decision) {
    case 'granted':
      tone(880, 0, 0.09);
      tone(1320, 0.09, 0.11);
      break;
    case 'denied':
      tone(220, 0, 0.18);
      tone(180, 0.2, 0.24);
      break;
    case 'unknown':
      tone(660, 0, 0.1);
      tone(660, 0.16, 0.1);
      break;
    default:
      tone(520, 0, 0.06, 0.03);
  }
}
