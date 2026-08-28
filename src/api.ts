/**
 * Dostęp do danych z poziomu interfejsu.
 *
 * W aplikacji Electron używamy mostka `window.rfid` (electron/preload.cjs).
 * Uruchomiony sam serwer Vite (`npm run dev:web`, wygodne przy pracy nad UI)
 * nie ma procesu głównego — wtedy podstawiamy ten sam magazyn i tę samą logikę
 * decyzji, tylko z zapisem do localStorage. Reguły dostępu są więc identyczne
 * w obu trybach, bo pochodzą z jednego modułu `shared/`.
 */

import { Store } from '../shared/store.js';
import { ScanService } from '../shared/service.js';
import type { AkuvoxStatus, AppInfo, BridgeStatus, Card, CardInput, Inspection, ReaderInfo, RfidApi, ScanQuery, ScanResult, Settings, Stats } from './types';

const STORAGE_KEY = 'rfid-scanner-data';

function localStorageAdapter() {
  return {
    label: `localStorage:${STORAGE_KEY}`,
    read: () => window.localStorage.getItem(STORAGE_KEY),
    write: (text: string) => window.localStorage.setItem(STORAGE_KEY, text),
    quarantine: () => {
      const broken = window.localStorage.getItem(STORAGE_KEY);
      if (broken) window.localStorage.setItem(`${STORAGE_KEY}.corrupt.${Date.now()}`, broken);
    },
  };
}

function downloadCsv(name: string, csv: string) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function webBridgeStatus(): BridgeStatus {
  return {
    running: false,
    enabled: false,
    port: 8787,
    token: '',
    error: 'Serwer telefonu wymaga aplikacji Electron — w podglądzie przeglądarkowym nie działa.',
    addresses: [],
    urls: [],
  };
}

const BEZ_ELECTRONA = 'Integracja z chmurą działa tylko w aplikacji — podgląd w przeglądarce nie ma procesu głównego.';

function webAkuvoxStatus(): AkuvoxStatus {
  return {
    enabled: false,
    baseUrl: '',
    region: '',
    cardFormat: 'dec',
    clientId: '',
    username: '',
    dryRun: false,
    hasClientSecret: false,
    hasPassword: false,
    secretStorageAvailable: false,
    configured: false,
    missing: [BEZ_ELECTRONA],
    regions: [],
    cardFormats: [],
    caveats: [BEZ_ELECTRONA],
    docs: 'https://developer.akubela.com',
    unsynced: 0,
  };
}

function createWebApi(): RfidApi {
  const store = new Store(localStorageAdapter());
  const service = new ScanService(store);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  return {
    isElectron: false,
    scan: async (raw, station) => service.processScan(raw, { station }) as ScanResult,
    inspect: async (raw) => service.inspect(raw) as Inspection,
    listCards: async (query) => store.listCards(query || {}) as Card[],
    getCard: async (id) => store.getCard(id) as Card | null,
    createCard: async (input: CardInput) => service.enroll(input) as Card,
    updateCard: async (id, patch) => store.updateCard(id, patch) as Card,
    deleteCard: async (id) => store.deleteCard(id) as boolean,
    listScans: async (query?: ScanQuery) => store.listScans(query || {}),
    clearScans: async () => {
      store.data.scans = [];
      store.save();
      return true;
    },
    stats: async () => store.stats() as Stats,
    getSettings: async () => store.getSettings() as Settings,
    setSettings: async (patch) => store.setSettings(patch) as Settings,
    exportCsv: async (kind) => {
      const csv = kind === 'cards' ? store.cardsCsv() : store.scansCsv();
      downloadCsv(kind === 'cards' ? `karty-${stamp()}.csv` : `historia-${stamp()}.csv`, csv);
      return { ok: true };
    },
    // Serwer telefonu żyje w procesie głównym — w podglądzie przeglądarkowym
    // go nie ma, więc zgłaszamy stan wyłączony wraz z wyjaśnieniem.
    bridgeStatus: async (): Promise<BridgeStatus> => webBridgeStatus(),
    bridgeStart: async () => webBridgeStatus(),
    bridgeStop: async () => webBridgeStatus(),
    bridgeRestart: async () => webBridgeStatus(),
    bridgeRegenerateToken: async () => webBridgeStatus(),
    onPhoneScan: () => () => {},

    akuvoxStatus: async () => webAkuvoxStatus(),
    akuvoxSave: async () => webAkuvoxStatus(),
    akuvoxTest: async () => ({ ok: false, steps: [{ step: 'środowisko', ok: false, detail: BEZ_ELECTRONA }] }),
    akuvoxSites: async () => [],
    akuvoxApartments: async () => [],
    akuvoxResidents: async () => [],
    akuvoxResidentCards: async () => [],
    akuvoxAssign: async () => ({ ok: false, error: BEZ_ELECTRONA }),
    akuvoxUnassign: async () => ({ ok: false, error: BEZ_ELECTRONA }),
    akuvoxRetry: async () => ({ total: 0, ok: 0 }),
    akuvoxLog: async () => [],

    detectReaders: async (): Promise<ReaderInfo> => ({
      supported: false,
      platform: 'web',
      devices: [],
      matches: [],
      hint: 'Podgląd w przeglądarce nie ma dostępu do listy urządzeń USB. Czytnik HID i tak wpisuje numer jak klawiatura, więc odczyt działa.',
    }),
    appInfo: async (): Promise<AppInfo> => ({
      version: '1.0.0',
      electron: '—',
      chrome: navigator.userAgent,
      node: '—',
      platform: 'web',
      dataFile: `localStorage:${STORAGE_KEY}`,
      isDev: true,
    }),
  };
}

declare global {
  interface Window {
    rfid?: RfidApi;
  }
}

export const api: RfidApi = window.rfid ?? createWebApi();
export const isElectron = Boolean(window.rfid?.isElectron);
