<div align="center">

# 🏷️ RFID Reader App

**Desktop application for USB RFID readers — 13.56 MHz, ISO14443A, S50/S70.**
Reads contactless cards, keeps a card database with permissions, and logs every scan.

[![CI](https://github.com/Ziut3k-dev/RFID-Reader-App/actions/workflows/ci.yml/badge.svg)](https://github.com/Ziut3k-dev/RFID-Reader-App/actions/workflows/ci.yml)
[![Release](https://github.com/Ziut3k-dev/RFID-Reader-App/actions/workflows/release.yml/badge.svg)](https://github.com/Ziut3k-dev/RFID-Reader-App/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-34-47848F.svg)](https://electronjs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev)

🇵🇱 [Wersja polska](docs/README.pl.md)

</div>

---

## 🔌 How the reader works — read this first

Readers of this class (ProRock / Sycreader **“SYC ID&IC USB Reader”**, VID `0xFFFF` / PID `0x0035`,
and most 13.56 MHz USB readers sold as “OTG”) have **no driver, no serial port and no PC/SC API**.
They register as a **USB HID keyboard**: when a card comes close, the reader *types* its number
character by character and usually appends Enter.

This app therefore captures keyboard events — nothing to install, no USB permissions to grant.
Practical consequences:

* works identically on macOS, Windows and Linux;
* a scan only reaches the app while its window has focus;
* the same card arrives in different shapes depending on the reader's hardware mode (see below).

> **Not supported:** 125 kHz cards (EM4100 and friends) — a 13.56 MHz reader cannot read them,
> and no software can change that. Writing to cards is also out of scope: a keyboard-wedge reader
> only ever sends the UID, it has no channel to send commands back.

## 🚀 Key features

* **Real-time scanning** — large, readable-from-across-the-room verdict: access granted / denied /
  unknown card, with owner details, every UID representation and an audio cue.
* **Card database** — name, owner, role, block flag, validity range, note, scan counter, search.
* **Enrollment in one click** — an unknown card can be added without leaving the scan panel;
  the scan that triggered it is retroactively corrected in the log.
* **Scan history** — filter by result, date range and free text; paginated.
* **CSV export** — cards and history, UTF-8 with BOM so Excel gets the accents right.
* **Reader diagnostics** — shows the exact characters the reader sent, the typing speed
  (machine vs. human) and how the number is interpreted in each of the three modes.
* **Access rules** — block flag, validity window, repeat-scan suppression, station name per reading.
* **Offline by design** — no network calls, no telemetry, no accounts. Data stays in one local file.

## 🛠️ Tech stack

| Layer | Choice |
| --- | --- |
| Shell | Electron 34 (context isolation on, `nodeIntegration` off, CSP in packaged builds) |
| UI | React 19 + TypeScript 5.7, bundled by Vite 6 |
| Logic | Plain JavaScript in `shared/` — shared by the main process and the renderer |
| Storage | Single JSON file, written atomically (temp file + `rename`) |
| Hardware | USB HID keyboard events (no native modules, no `pip`/`node-gyp` build step) |
| Packaging | electron-builder 26 → dmg/zip, NSIS/portable, AppImage/deb/tar.gz |

**Zero production dependencies.** `npm install` pulls dev tooling only, so there is nothing to
compile and nothing that can break on a different OS or Node version.

## 📦 Getting started

### Prerequisites

* Node.js 20 or newer (developed on 22).
* A 13.56 MHz ISO14443A USB reader. The app also runs without one — you can type card numbers by hand.

### Installation

```bash
git clone https://github.com/Ziut3k-dev/RFID-Reader-App.git
cd RFID-Reader-App
npm install
```

### Run

```bash
npm start        # build the UI and launch the app
npm run dev      # development: Vite HMR + Electron
npm run dev:web  # UI only in a browser (data in localStorage) — handy for styling
```

## 🔢 Card number formats

The reader's output mode is set in hardware. All common variants are recognised and reduced to one
canonical number:

| What the reader sends | Interpretation |
| --- | --- |
| `0004372425` | 10 decimal digits, zero-padded (DEC mode) |
| `0042B7C9` | 8 hex characters (HEX mode) |
| `C9B74200` | hex with reversed byte order (LSB first) |
| `0004372425,0042,44873` | Wiegand — the number is the first field |
| `04:A2:2B:9C:11:44:80` | 7-byte UID with separators |

A card enrolled from a reading in one mode **is still found after a reading in another** — lookup
checks both byte orders. History stores the card's canonical number, with the raw reading kept in a
separate field.

The interpretation mode lives in **Settings** (`AUTO` / `DEC` / `HEX`). If you don't know which mode
your reader uses, open **Reader diagnostics** and tap a card: it prints the raw characters and the
result in all three modes side by side.

## 🔐 Access rules

Evaluated in this order ([`shared/core.js`](shared/core.js), function `evaluate`):

1. **repeat scan** — a card resting on the reader produces a stream of readings; repeats inside the
   suppression window (3 s by default) are dropped and never reach the log;
2. **unknown card** — denied, or auto-enrolled when learning mode is on;
3. **blocked card** — denied;
4. **outside validity range** — denied, with the date in the reason;
5. otherwise **access granted**.

## 💾 Data

One JSON file, written atomically so an interrupted write cannot corrupt the database:

* packaged app — the OS application-data directory
  (macOS: `~/Library/Application Support/rfid-scanner/rfid-data.json`);
* run from the repository — `data/rfid-data.json`.

Settings shows the exact path, and **File → Show database file** reveals it in the file manager.
A corrupted file is never overwritten silently — it is set aside as `*.corrupt-<timestamp>`.

## 🗂️ Project structure

```
shared/        environment-independent logic
  core.js        card number parsing + access rules
  store.js       data store (pluggable persistence adapter)
  service.js     scan processing, enrollment, diagnostics
electron/
  main.js        window, menu, IPC, CSP
  preload.cjs    bridge to the renderer
  persistence.js JSON file adapter
  reader.js      USB reader detection (ioreg / lsusb / PnP)
src/           React UI
  hooks/useKeyboardWedge.ts   HID keyboard capture
scripts/
  make-icon.js   renders build/icon.svg to a 1024px PNG using Electron
tests/         logic tests (node:test)
```

The rules live in `shared/`, so the Electron app and the browser preview reach identical decisions —
there is no second implementation to keep in sync.

## ✅ Tests

```bash
npm test        # 32 tests: number parsing, store, access rules
npm run typecheck
```

## 🏗️ Building installers

```bash
npm run dist:mac     # dmg + zip (arm64, x64)
npm run dist:win     # NSIS installer + portable (x64, arm64 installer)
npm run dist:linux   # AppImage + deb + tar.gz (x64, arm64)
npm run pack         # unpacked app only — quick sanity check
npm run icon         # regenerate build/icon.png from build/icon.svg
```

Output lands in `release/`. Each installer format needs its own host OS for a reliable result
(`.dmg` requires macOS, `.exe` requires Windows), which is what the release workflow is for.

### Releasing through GitHub Actions

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds all three platforms on their
native runners, then attaches every artifact to a **draft** GitHub release:

```bash
# bump "version" in package.json first — the workflow checks it against the tag
git tag v1.0.0
git push origin v1.0.0
```

You can also start it from the Actions tab (it only builds unless you tick *publish*). Review the
draft, then hit Publish. [`ci.yml`](.github/workflows/ci.yml) runs tests, typecheck and a trial
packaging on all three systems for every push and pull request.

### Code signing

Builds are unsigned, so no secrets are required to release. To sign macOS builds, remove
`identity: null` from [`electron-builder.yml`](electron-builder.yml) and set `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as repository
secrets. For Windows, provide `CSC_LINK` and `CSC_KEY_PASSWORD` with an Authenticode certificate.

Until then, first launch shows a warning: on macOS right-click → **Open**, on Windows SmartScreen →
**More info** → **Run anyway**.

## 🩺 Troubleshooting

**Nothing happens when I tap a card.** Check that the app window is focused and the indicator reads
*Nasłuch aktywny* (listening). Then open Settings → Reader diagnostics: if no characters appear at
all, the reader is not sending keystrokes — try another USB port, and confirm the card is ISO14443A
(a 13.56 MHz reader cannot read 125 kHz cards).

**The number doesn't match the label on the card.** The reader runs in a different mode than the one
configured. Diagnostics shows which mode produces the number printed on the card; select it in Settings.

**One card got stored twice.** Older entries may come from readings taken in different modes. Delete
the duplicate under Cards; later readings will map to a single card.

**One tap creates several log entries.** Increase the repeat-scan suppression window in Settings.

## 🤝 Contributing

Issues and pull requests are welcome. Please run `npm test` and `npm run typecheck` before opening a
PR — CI runs both, plus a trial packaging on macOS, Windows and Linux.

## 🔒 Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md), which also
describes the app's security posture (offline by design, unencrypted local data, unsigned releases)
and what falls outside its threat model.

## 📄 License

[MIT](LICENSE) — do what you like, keep the copyright notice, no warranty.
