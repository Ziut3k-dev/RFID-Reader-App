<div align="center">

# 🏷️ RFID Reader App

**Desktop application for USB RFID readers — 13.56 MHz, ISO14443A, S50/S70.**
Reads contactless cards, keeps a card database with permissions, and logs every scan.

[![CI](https://github.com/Ziut3k-dev/RFID-Reader-App/actions/workflows/ci.yml/badge.svg)](https://github.com/Ziut3k-dev/RFID-Reader-App/actions/workflows/ci.yml)
[![Release](https://github.com/Ziut3k-dev/RFID-Reader-App/actions/workflows/release.yml/badge.svg)](https://github.com/Ziut3k-dev/RFID-Reader-App/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-47848F.svg)](https://electronjs.org)
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
* **iPhone as a scanner** — the app can serve a scanner page on your LAN and show a QR code to pair
  a phone; the phone reads QR/barcodes with its camera and the scans land in the same pipeline.
* **Offline by design** — no outbound network calls, no telemetry, no accounts. Data stays in one
  local file, and the optional phone server is off by default.

## 🛠️ Tech stack

| Layer | Choice |
| --- | --- |
| Shell | Electron 43 (context isolation on, `nodeIntegration` off, CSP in packaged builds) |
| UI | React 19 + TypeScript 7, bundled by Vite 8 |
| Logic | Plain JavaScript in `shared/` — shared by the main process and the renderer |
| Storage | Single JSON file, written atomically (temp file + `rename`) |
| Hardware | USB HID keyboard events (no native modules, no `pip`/`node-gyp` build step) |
| Phone bridge | Node's built-in `http` server + a second Vite entry point for the phone page |
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

## 📱 iPhone as a scanner

Enable the server under the **Telefon** tab. The app shows a QR code with a pairing URL like
`http://192.168.1.42:8787/s/<secret>`; point the iPhone's Camera app at it and Safari opens the
scanner page. Phone and computer must be on the same Wi-Fi.

What the phone does:

* reads **QR and barcodes** with the camera and submits the decoded value,
* accepts a number typed by hand (from a badge label),
* shows the verdict — granted / denied / unknown — plus the recent scans.

Scans from the phone go through the *same* access rules as the USB reader and appear in history with
the station suffixed `/telefon` or `/kamera`. They also pop up on the desktop scan panel, so an
operator watching the app sees them live.

**What the phone cannot do:** an iPhone cannot read an RFID card from a web page. Safari has no Web
NFC (that API exists only in Chrome on Android), so contactless cards still need the USB reader. The
phone is a camera scanner and a keypad, not an RFID reader.

Two camera paths, because browsers gate camera access differently:

| Path | Works where | Notes |
| --- | --- | --- |
| Live preview (`getUserMedia`) | Android, or over HTTPS | Continuous scanning; hidden when unavailable |
| Photo from the system camera (`<input capture>`) | Everywhere, including iOS over plain HTTP | One photo per scan |

Codes are decoded in the phone's browser, so photos never leave the device — only the decoded number
is sent.

**Security:** the server listens only while enabled and every request needs the secret from the
pairing URL. Anyone who photographs the QR code can register scans, so regenerate the secret (one
button) or stop the server when you're done, and keep it on a trusted network — the connection is not
encrypted. See [SECURITY.md](SECURITY.md) for the full picture.

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

Running it manually from the Actions tab only builds and keeps the packages as run artifacts — a
release is created from a tag only. Review the draft, then hit Publish.
[`ci.yml`](.github/workflows/ci.yml) runs tests, typecheck and a trial packaging on all three
systems for every push and pull request.

### Code scanning

[`codeql.yml`](.github/workflows/codeql.yml) runs CodeQL with the `security-and-quality` suite on
every push, every pull request and weekly. **One-time repository setting:** GitHub enables its own
*default setup* for code scanning on public repositories, and that blocks results uploaded by a
custom workflow — the analysis step fails even though the scan itself ran fine. Disable it under
*Settings → Code security → Code scanning → CodeQL analysis → Disable*, or delete `codeql.yml` and
keep GitHub's default setup instead (scanning still works, you just don't control the query suite or
the schedule).

[Dependabot](.github/dependabot.yml) proposes dependency and action updates weekly. Electron is a
dev dependency but ships inside the packaged app, so its advisories affect end users — worth keeping
current.

### Commit and tag signing

Commits and tags are signed with an SSH key, so GitHub shows them as **Verified**. Two different
things are called “signing” here — this is git signing (who authored the commit), separate from
installer code signing below (who built the binary).

To set it up on a fresh clone:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_signing -C "you@example.com (git signing)"
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519_signing.pub
git config commit.gpgsign true
git config tag.gpgsign true
```

Then add the **public** key to GitHub under *Settings → SSH and GPG keys → New SSH key* with key
type **Signing Key** (an authentication key alone does not make commits Verified).

To verify signatures locally, git needs to know which keys to trust:

```bash
printf 'you@example.com namespaces="git" %s\n' "$(cut -d' ' -f1,2 ~/.ssh/id_ed25519_signing.pub)" \
  > ~/.ssh/allowed_signers
git config gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
git log --show-signature -1
git tag -v v1.0.0
```

### Installer code signing

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
