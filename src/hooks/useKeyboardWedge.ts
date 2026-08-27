import { useEffect, useRef } from 'react';

/**
 * Przechwytywanie odczytu z czytnika RFID pracującego jako klawiatura USB HID.
 *
 * Czytnik (np. ProRock / Sycreader „SYC ID&IC USB Reader”) po zbliżeniu karty
 * „wpisuje” jej numer znak po znaku i zwykle kończy Enterem. Nie ma tu portu
 * szeregowego ani API — jedyne, co widzi aplikacja, to zdarzenia klawiatury.
 *
 * Odczyt domykamy na dwa sposoby, bo konfiguracja sprzętowa bywa różna:
 *   1. Enter — czytnik z włączonym sufiksem (ustawienie domyślne),
 *   2. przerwa w pisaniu — czytnik bez sufiksu; człowiek nie zdąży wpisać
 *      kilkunastu znaków szybciej niż w `gapMs`, więc bufor można domknąć.
 */

export interface WedgeMeta {
  /** Średnia przerwa między znakami w ms — czytnik pisze znacznie szybciej niż człowiek. */
  avgGapMs: number;
  /** Czy odczyt domknął Enter (a nie upływ czasu). */
  viaEnter: boolean;
  /** Odczyt wygląda na maszynowy, nie na ręczne pisanie. */
  machineTyped: boolean;
  chars: number;
}

interface Options {
  enabled: boolean;
  onScan: (raw: string, meta: WedgeMeta) => void;
  /** Przerwa domykająca odczyt bez Entera. */
  gapMs?: number;
  /** Krótsze ciągi ignorujemy — to przypadkowe naciśnięcia klawiszy. */
  minLength?: number;
}

/** Znaki, które czytniki wysyłają: cyfry, HEX, separatory formatu Wiegand. */
const ACCEPTED = /^[0-9A-Fa-f,;:\-_]$/;

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useKeyboardWedge({ enabled, onScan, gapMs = 220, minLength = 4 }: Options) {
  const bufferRef = useRef('');
  const timesRef = useRef<number[]>([]);
  const timerRef = useRef<number | null>(null);
  // Callback trzymamy w referencji, żeby zmiana handlera nie przepinała nasłuchu
  // w środku odczytu (i nie gubiła zebranego bufora).
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const commit = (viaEnter: boolean) => {
      clearTimer();
      const raw = bufferRef.current;
      const times = timesRef.current;
      bufferRef.current = '';
      timesRef.current = [];
      if (raw.length < minLength) return;

      let avgGapMs = 0;
      if (times.length > 1) {
        avgGapMs = (times[times.length - 1] - times[0]) / (times.length - 1);
      }
      onScanRef.current(raw, {
        avgGapMs: Math.round(avgGapMs),
        viaEnter,
        machineTyped: times.length > 1 && avgGapMs < 40,
        chars: raw.length,
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Pisanie w formularzach zostawiamy w spokoju; pole odczytu oznaczamy
      // atrybutem data-wedge, żeby czytnik działał także wtedy, gdy ma fokus.
      const target = event.target as HTMLElement | null;
      if (isEditable(target) && target?.dataset.wedge === undefined) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Enter' || event.key === 'Tab') {
        if (bufferRef.current.length >= minLength) {
          event.preventDefault();
          commit(true);
        } else {
          bufferRef.current = '';
          timesRef.current = [];
          clearTimer();
        }
        return;
      }

      if (event.key.length !== 1 || !ACCEPTED.test(event.key)) return;

      bufferRef.current += event.key;
      timesRef.current.push(performance.now());
      clearTimer();
      timerRef.current = window.setTimeout(() => commit(false), gapMs);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      clearTimer();
      bufferRef.current = '';
      timesRef.current = [];
    };
  }, [enabled, gapMs, minLength]);
}
