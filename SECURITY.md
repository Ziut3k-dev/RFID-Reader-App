# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue.

* Preferred: [GitHub private security advisory](https://github.com/Ziut3k-dev/RFID-Reader-App/security/advisories/new)
* Or e-mail: **k.wlodarski@siecportali.pl**

Zgłoszenia po polsku są równie mile widziane.

Helpful details: affected version, operating system, what you did, what happened, and — if you have
one — a minimal reproduction. Please do not include real card UIDs or personal data from a
production deployment; a redacted example is enough.

Expect an acknowledgement within a few days. Fixes ship in a normal release, and the advisory is
published once a fixed version is available. Credit is given unless you prefer otherwise.

## Supported versions

This is a small project without long-term branches: **only the latest release is supported.**
Fixes land on `master` and go out in the next tagged release.

| Version | Supported |
| --- | --- |
| latest release | ✅ |
| anything older | ❌ (please update) |

## Security posture

Worth knowing before you assess a finding — several properties are deliberate:

* **No network access.** The app makes no HTTP requests, has no telemetry, no accounts and no
  auto-update. Packaged builds run with a Content Security Policy restricted to `'self'`.
* **No production dependencies.** `npm install` pulls development tooling only, which keeps the
  runtime supply-chain surface at Electron itself.
* **Renderer is sandboxed from Node.** `contextIsolation` is on, `nodeIntegration` is off, and the
  renderer reaches the main process only through the narrow API in
  [`electron/preload.cjs`](electron/preload.cjs). External links open in the system browser.
* **Local data is not encrypted.** Cards and scan history live in a plain JSON file in the user's
  application-data directory, readable by anything running as that user. If your deployment treats
  card UIDs or owner names as sensitive, protect them at the OS level (disk encryption, file
  permissions, a dedicated account).
* **No authentication in the app.** Anyone who can use the window can edit the card database. The
  app is designed for a single trusted operator station, not for multi-user access control.
* **Releases are unsigned.** Artifacts carry no Apple or Authenticode signature, so the OS will warn
  on first launch and you cannot verify authorship from the file alone. Download only from the
  [Releases page](https://github.com/Ziut3k-dev/RFID-Reader-App/releases) of this repository.

## Out of scope

* **RFID cloning and card cryptography.** The reader is a USB HID keyboard: it only ever types the
  card's UID. Mifare Classic S50/S70 UIDs are not secrets and are trivially cloneable with
  purpose-built hardware — that is a property of the card standard, not a bug in this app. Do not
  use UID-only checks as the sole control for anything genuinely valuable.
* **Keystroke capture by design.** While the scan panel is focused, the app records the characters
  the reader types. That is the only way a keyboard-wedge reader can be read at all. It captures
  only within its own focused window — it installs no system-wide keyboard hook.
* Findings that require an attacker to already run code as the user, or physical access to an
  unlocked machine.
