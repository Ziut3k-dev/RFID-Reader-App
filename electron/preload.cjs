/**
 * Mostek między procesem renderującym a procesem głównym.
 * Renderer nie ma dostępu do Node — wyłącznie do tych funkcji.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Rozpakowuje { ok, data, error } z handlerów IPC do zwykłego wyniku/wyjątku. */
async function call(channel, payload) {
  const res = await ipcRenderer.invoke(channel, payload);
  if (res && res.ok === false && 'error' in res) {
    const err = new Error(res.error);
    err.code = res.code;
    throw err;
  }
  return res && 'data' in res ? res.data : res;
}

contextBridge.exposeInMainWorld('rfid', {
  isElectron: true,

  scan: (raw, station) => ipcRenderer.invoke('scan:process', { raw, station }),
  inspect: (raw) => ipcRenderer.invoke('scan:inspect', { raw }),

  listCards: (query) => call('cards:list', query),
  getCard: (id) => call('cards:get', { id }),
  createCard: (input) => call('cards:create', input),
  updateCard: (id, patch) => call('cards:update', { id, patch }),
  deleteCard: (id) => call('cards:delete', { id }),

  listScans: (query) => call('scans:list', query),
  clearScans: () => call('scans:clear'),

  stats: () => call('stats:get'),
  getSettings: () => call('settings:get'),
  setSettings: (patch) => call('settings:set', patch),

  bridgeStatus: () => call('bridge:status'),
  bridgeStart: () => call('bridge:start'),
  bridgeStop: () => call('bridge:stop'),
  bridgeRestart: (port) => call('bridge:restart', { port }),
  bridgeRegenerateToken: () => call('bridge:regenerate-token'),

  /**
   * Odczyty przychodzące z telefonu. Zwraca funkcję odsubskrybowania, żeby
   * komponent Reacta mógł ją wywołać przy odmontowaniu.
   */
  onPhoneScan: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('bridge:scan', listener);
    return () => ipcRenderer.removeListener('bridge:scan', listener);
  },

  akuvoxStatus: () => call('akuvox:status'),
  akuvoxSave: (patch) => call('akuvox:save', patch),
  akuvoxTest: () => call('akuvox:test'),
  akuvoxSites: () => call('akuvox:sites'),
  akuvoxApartments: (siteId) => call('akuvox:apartments', { siteId }),
  akuvoxResidents: (siteId, apartmentId) => call('akuvox:residents', { siteId, apartmentId }),
  akuvoxResidentCards: (target) => call('akuvox:resident-cards', target),
  akuvoxAssign: (cardId, target) => call('akuvox:assign', { cardId, target }),
  akuvoxUnassign: (cardId) => call('akuvox:unassign', { cardId }),
  akuvoxRetry: () => call('akuvox:retry'),
  akuvoxLog: () => call('akuvox:log'),

  exportCsv: (kind) => call('export:csv', { kind }),
  detectReaders: () => call('reader:detect'),
  appInfo: () => call('app:info'),
});
