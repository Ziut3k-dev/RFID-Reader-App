/**
 * Sekrety integracji (klucze API) trzymamy poza zwykłym plikiem z danymi.
 *
 * Baza kart to czysty JSON — dopisanie do niej klucza API oznaczałoby sekret
 * leżący jawnie na dysku i w każdej kopii zapasowej. Dlatego szyfrujemy go
 * mechanizmem systemowym (`safeStorage`: Keychain na macOS, DPAPI na Windows,
 * keyring na Linuksie) i zapisujemy w osobnym pliku jako bajty.
 *
 * Gdy system nie udostępnia szyfrowania (bywa tak na Linuksie bez keyringu),
 * nie zapisujemy sekretu w formie odwracalnej po cichu — zwracamy błąd, a
 * interfejs prosi o podanie klucza przy każdym uruchomieniu.
 */

import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export class SecretStore {
  constructor(filePath) {
    this.file = filePath;
    this.cache = null;
  }

  get available() {
    return safeStorage.isEncryptionAvailable();
  }

  /** @returns {Record<string, string>} */
  all() {
    if (this.cache) return this.cache;
    try {
      const blob = fs.readFileSync(this.file);
      const text = this.available ? safeStorage.decryptString(blob) : blob.toString('utf8');
      this.cache = JSON.parse(text);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Sekretów nie da się odzyskać po zmianie klucza systemowego
        // (np. po przeniesieniu profilu) — zaczynamy od zera, zamiast wywracać
        // uruchomienie aplikacji.
        try { fs.rmSync(this.file, { force: true }); } catch { /* nic więcej */ }
      }
      this.cache = {};
    }
    return this.cache;
  }

  get(key) {
    return this.all()[key] ?? '';
  }

  /** Zapisuje sekret; puste wartości usuwają wpis. */
  set(key, value) {
    if (!this.available) {
      const err = new Error(
        'System nie udostępnia szyfrowanego magazynu haseł, więc klucz API nie zostanie zapisany na dysku. ' +
        'Na Linuksie zwykle brakuje działającego keyringu (gnome-keyring, kwallet).',
      );
      err.code = 'NO_SAFE_STORAGE';
      throw err;
    }
    const data = { ...this.all() };
    if (value) data[key] = String(value);
    else delete data[key];
    this.cache = data;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(data)));
    fs.renameSync(tmp, this.file);
  }

  /** Czy sekret jest ustawiony — bez ujawniania wartości interfejsowi. */
  has(key) {
    return Boolean(this.get(key));
  }

  clear() {
    this.cache = {};
    try { fs.rmSync(this.file, { force: true }); } catch { /* nic więcej */ }
  }
}
