/**
 * Wykrywanie podłączonego czytnika RFID.
 *
 * Czytniki tej klasy (Sycreader / ProRock "SYC ID&IC USB Reader", ISO14443A
 * 13.56 MHz) zgłaszają się systemowi jako klawiatura USB HID. Nie ma do nich
 * portu szeregowego ani API — numer karty przychodzi jako naciśnięcia klawiszy.
 * Ta funkcja służy więc tylko do potwierdzenia użytkownikowi, że sprzęt jest
 * widziany przez system; sam odczyt realizuje przechwytywanie klawiatury.
 */

import { execFile } from 'node:child_process';

const KNOWN_PATTERNS = [
  /SYC\s*ID&?IC/i,
  /Sycreader/i,
  /ProRock/i,
  /RFID/i,
  /ID\s*&\s*IC/i,
  /NFC/i,
  /13\.?56/i,
  /Mifare/i,
];

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

function looksLikeReader(text) {
  return KNOWN_PATTERNS.some((re) => re.test(text));
}

async function detectMac() {
  const out = await run('/usr/sbin/ioreg', ['-p', 'IOUSB', '-l', '-w', '0']);
  if (!out) return [];

  // ioreg wypisuje właściwości urządzenia w dowolnej kolejności, także przed
  // jego nazwą, dlatego tekst trzeba najpierw pociąć na bloki urządzeń
  // (linie "+-o nazwa@adres <class IOUSBHostDevice ...>"). Bez tego
  // właściwości sąsiada wpadają do poprzedniego wpisu.
  const devices = [];
  let current = null;

  for (const line of out.split('\n')) {
    const node = /\+-o\s+(.+?)@[0-9a-fA-F]+\s+<class\s+([A-Za-z0-9_]+)/.exec(line);
    if (node) {
      if (node[2] === 'IOUSBHostDevice') {
        current = { name: node[1].trim(), vendor: '', vid: null, pid: null };
        devices.push(current);
      } else {
        // Kontroler albo inny węzeł — jego właściwości nas nie interesują.
        current = null;
      }
      continue;
    }
    if (!current) continue;

    const name = /"USB Product Name"\s*=\s*"([^"]*)"/.exec(line);
    if (name) { current.name = name[1]; continue; }
    const vendor = /"USB Vendor Name"\s*=\s*"([^"]*)"/.exec(line);
    if (vendor) { current.vendor = vendor[1]; continue; }
    const vid = /"idVendor"\s*=\s*(\d+)/.exec(line);
    if (vid) { current.vid = Number(vid[1]); continue; }
    const pid = /"idProduct"\s*=\s*(\d+)/.exec(line);
    if (pid) current.pid = Number(pid[1]);
  }

  return devices;
}

async function detectLinux() {
  const out = await run('lsusb', []);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = /ID\s+([0-9a-f]{4}):([0-9a-f]{4})\s+(.*)$/i.exec(line);
      return m
        ? { name: m[3].trim(), vendor: '', vid: parseInt(m[1], 16), pid: parseInt(m[2], 16) }
        : { name: line.trim(), vendor: '', vid: null, pid: null };
    });
}

async function detectWindows() {
  const out = await run('powershell.exe', [
    '-NoProfile', '-Command',
    "Get-PnpDevice -Class HIDClass,Keyboard -PresentOnly | Select-Object -ExpandProperty FriendlyName",
  ], 8000);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((name) => ({ name, vendor: '', vid: null, pid: null }));
}

/** Zwraca { supported, devices, matches } — matches to prawdopodobne czytniki. */
export async function detectReaders() {
  let devices = [];
  let supported = true;
  try {
    if (process.platform === 'darwin') devices = await detectMac();
    else if (process.platform === 'linux') devices = await detectLinux();
    else if (process.platform === 'win32') devices = await detectWindows();
    else supported = false;
  } catch {
    devices = [];
  }
  const matches = devices.filter((d) => looksLikeReader(`${d.name} ${d.vendor}`));
  return {
    supported,
    platform: process.platform,
    devices,
    matches,
    hint: matches.length
      ? 'Czytnik widoczny w systemie jako klawiatura USB HID — kliknij pole odczytu i zbliż kartę.'
      : 'Nie znaleziono czytnika na liście urządzeń USB. Aplikacja nadal działa — czytnik HID wpisuje numer jak klawiatura, więc wystarczy aktywne pole odczytu.',
  };
}
