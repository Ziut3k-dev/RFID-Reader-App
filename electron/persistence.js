/**
 * Adapter zapisu dla procesu głównego: jeden plik JSON, zapis atomowy
 * (plik tymczasowy + rename), żeby przerwanie zapisu nie zniszczyło bazy.
 */

import fs from 'node:fs';
import path from 'node:path';

export function fileAdapter(filePath) {
  return {
    label: filePath,

    read() {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    write(text) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, filePath);
    },

    quarantine() {
      try {
        fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch { /* plik mógł już nie istnieć */ }
    },
  };
}
