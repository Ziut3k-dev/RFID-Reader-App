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

/** Powiązanie karty z systemem zewnętrznym (chmura Akuvox). */
export interface CardLink {
  provider: string;
  siteId: string;
  siteName: string;
  apartmentId: string;
  apartmentName: string;
  residentId: string;
  residentName: string;
  remoteId: string;
  state: 'none' | 'pending' | 'synced' | 'error' | 'removing';
  syncedAt: string;
  error: string;
}

export interface AkuvoxRegion {
  id: string;
  name: string;
  baseUrl: string;
}

export interface AkuvoxCardFormat {
  id: string;
  name: string;
  hint: string;
}

export interface AkuvoxStatus {
  enabled: boolean;
  baseUrl: string;
  region: string;
  cardFormat: string;
  clientId: string;
  username: string;
  dryRun: boolean;
  hasClientSecret: boolean;
  hasPassword: boolean;
  secretStorageAvailable: boolean;
  configured: boolean;
  missing: string[];
  regions: AkuvoxRegion[];
  cardFormats: AkuvoxCardFormat[];
  caveats: string[];
  docs: string;
  unsynced: number;
}

export interface AkuvoxSaveInput {
  akuvoxEnabled?: boolean;
  akuvoxRegion?: string;
  akuvoxBaseUrl?: string;
  akuvoxCardFormat?: string;
  akuvoxClientId?: string;
  akuvoxUsername?: string;
  akuvoxDryRun?: boolean;
  clientSecret?: string;
  password?: string;
}

/** Pozycja listy z chmury (obiekt, mieszkanie, mieszkaniec). */
export interface RemoteItem {
  id: string;
  name: string;
  extra?: string;
}

export interface AkuvoxTestResult {
  ok: boolean;
  steps: { step: string; ok: boolean; detail: string }[];
  sites?: RemoteItem[];
}

export interface AkuvoxTarget {
  siteId: string;
  siteName?: string;
  apartmentId: string;
  apartmentName?: string;
  residentId: string;
  residentName?: string;
}

export interface AkuvoxAssignResult {
  ok: boolean;
  card?: Card;
  cardNumber?: string;
  remoteId?: string;
  error?: string;
}

export interface RequestLogEntry {
  at: string;
  method: string;
  url: string;
  status: number | null;
  ms: number;
  attempts: number;
  dryRun: boolean;
  error: string | null;
  body?: unknown;
  response?: unknown;
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
  link: CardLink;
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

  akuvoxStatus(): Promise<AkuvoxStatus>;
  akuvoxSave(patch: AkuvoxSaveInput): Promise<AkuvoxStatus>;
  akuvoxTest(): Promise<AkuvoxTestResult>;
  akuvoxSites(): Promise<RemoteItem[]>;
  akuvoxApartments(siteId: string): Promise<RemoteItem[]>;
  akuvoxResidents(siteId: string, apartmentId?: string): Promise<RemoteItem[]>;
  akuvoxResidentCards(target: AkuvoxTarget): Promise<RemoteItem[]>;
  akuvoxAssign(cardId: number, target: AkuvoxTarget): Promise<AkuvoxAssignResult>;
  akuvoxUnassign(cardId: number): Promise<{ ok: boolean; localOnly?: boolean; message?: string; error?: string }>;
  akuvoxRetry(): Promise<{ total: number; ok: number }>;
  akuvoxLog(): Promise<RequestLogEntry[]>;
  appInfo(): Promise<AppInfo>;
}
