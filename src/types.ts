/** Typy współdzielone przez cały interfejs. */

export type Decision = 'granted' | 'denied' | 'unknown' | 'duplicate';
export type UidFormat = 'auto' | 'dec' | 'hex';
export type UnknownPolicy = 'deny' | 'enroll';

export interface Uid {
  hex: string;
  hexReversed: string;
  pretty: string;
  dec: string;
  dec10: string;
  bytes: number;
  raw: string;
  source: 'dec' | 'hex' | 'wiegand';
}

export interface Card {
  id: number;
  uidHex: string;
  uidDec: string;
  bytes: number;
  label: string;
  owner: string;
  role: string;
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
  scanCount?: number;
}

export interface Scan {
  id: number;
  ts: string;
  uidHex: string;
  uidRaw: string;
  cardId: number | null;
  decision: Decision;
  reason: string;
  station: string;
  cardLabel?: string;
  cardOwner?: string;
}

export interface ScanResult {
  ok: boolean;
  error?: string;
  raw?: string;
  uid?: Uid;
  card?: Card | null;
  decision?: Decision;
  reason?: string;
  scan?: Scan | null;
  at?: string;
}

export interface Settings {
  uidFormat: UidFormat;
  unknownPolicy: UnknownPolicy;
  debounceSeconds: number;
  station: string;
  sound: boolean;
  maxScans: number;
  /** Serwer udostępniający telefon jako skaner */
  bridgeEnabled: boolean;
  bridgePort: number;
  /** Sekret w adresie sparowania — nie pokazujemy go poza kodem QR i adresem */
  bridgeToken: string;
}

export interface NetworkAddress {
  name: string;
  address: string;
}

export interface BridgeStatus {
  running: boolean;
  enabled: boolean;
  port: number;
  token: string;
  error: string | null;
  addresses: NetworkAddress[];
  urls: string[];
}

export interface Stats {
  cards: number;
  cardsActive: number;
  scansTotal: number;
  today: number;
  uniqueToday: number;
  granted: number;
  denied: number;
  unknown: number;
  duplicate: number;
}

export interface UsbDevice {
  name: string;
  vendor: string;
  vid: number | null;
  pid: number | null;
}

export interface ReaderInfo {
  supported: boolean;
  platform: string;
  devices: UsbDevice[];
  matches: UsbDevice[];
  hint: string;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  dataFile: string;
  isDev: boolean;
}

export interface CardInput {
  uid?: string;
  uidHex?: string;
  label?: string;
  owner?: string;
  role?: string;
  active?: boolean;
  validFrom?: string | null;
  validTo?: string | null;
  note?: string;
}

export interface ScanQuery {
  limit?: number;
  offset?: number;
  decision?: string;
  q?: string;
  from?: string;
  to?: string;
}

export interface Inspection {
  raw: string;
  auto: Uid | { error: string };
  dec: Uid | { error: string };
  hex: Uid | { error: string };
  activeFormat: UidFormat;
}

/** API wystawiane przez preload (electron/preload.cjs). */
export interface RfidApi {
  isElectron: boolean;
  scan(raw: string, station?: string): Promise<ScanResult>;
  inspect(raw: string): Promise<Inspection>;
  listCards(query?: { q?: string; activeOnly?: boolean }): Promise<Card[]>;
  getCard(id: number): Promise<Card | null>;
  createCard(input: CardInput): Promise<Card>;
  updateCard(id: number, patch: Partial<Card>): Promise<Card>;
  deleteCard(id: number): Promise<boolean>;
  listScans(query?: ScanQuery): Promise<{ total: number; rows: Scan[] }>;
  clearScans(): Promise<boolean>;
  stats(): Promise<Stats>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  exportCsv(kind: 'cards' | 'scans'): Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>;

  bridgeStatus(): Promise<BridgeStatus>;
  bridgeStart(): Promise<BridgeStatus>;
  bridgeStop(): Promise<BridgeStatus>;
  bridgeRestart(port?: number): Promise<BridgeStatus>;
  bridgeRegenerateToken(): Promise<BridgeStatus>;
  /** Subskrypcja odczytów z telefonu; zwraca funkcję odsubskrybowania. */
  onPhoneScan(callback: (result: ScanResult) => void): () => void;
  detectReaders(): Promise<ReaderInfo>;
  appInfo(): Promise<AppInfo>;
}
