/** Formatowanie na potrzeby widoku. */

import type { Decision } from '../types';

export const DECISION_LABEL: Record<Decision, string> = {
  granted: 'Dostęp przyznany',
  denied: 'Dostęp odmówiony',
  unknown: 'Karta nieznana',
  duplicate: 'Powtórny odczyt',
};

export const DECISION_SHORT: Record<Decision, string> = {
  granted: 'przyznany',
  denied: 'odmowa',
  unknown: 'nieznana',
  duplicate: 'powtórka',
};

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pl-PL', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
