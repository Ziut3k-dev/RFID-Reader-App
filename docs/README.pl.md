# RFID Reader App

🇬🇧 [English version](../README.md) · [github.com/Ziut3k-dev/RFID-Reader-App](https://github.com/Ziut3k-dev/RFID-Reader-App)

Aplikacja desktopowa (Electron + React) do obsługi czytnika RFID USB
**13,56 MHz, ISO14443A, S50/S70** — m.in. ProRock / Sycreader
„SYC ID&IC USB Reader”. Rejestruje odczyty kart, prowadzi bazę kart
z uprawnieniami i dziennik wejść.

## Jak działa czytnik

Czytniki tej klasy **nie mają sterownika ani portu szeregowego**. Zgłaszają się
systemowi jako **klawiatura USB HID**: po zbliżeniu karty „wpisują” jej numer
znak po znaku i zwykle dodają Enter. Aplikacja przechwytuje więc zdarzenia
klawiatury — wystarczy, że jej okno jest aktywne. Nie trzeba nic instalować
ani przydzielać uprawnień USB.

Konsekwencje praktyczne:

* działa na macOS, Windows i Linuksie tak samo,
* odczyt trafia do aplikacji tylko wtedy, gdy jej okno ma fokus,
* ten sam numer karty może przyjść w różnych postaciach — patrz niżej.

## Formaty numeru karty

Czytnik ma sprzętowo ustawiany tryb wyjścia. Aplikacja rozpoznaje wszystkie
spotykane warianty i sprowadza je do jednego numeru kanonicznego:

| Odczyt z czytnika        | Interpretacja                              |
| ------------------------ | ------------------------------------------ |
| `0004372425`             | 10 cyfr dziesiętnych (tryb DEC)            |
| `0042B7C9`               | 8 znaków HEX (tryb HEX)                    |
| `C9B74200`               | HEX z odwróconą kolejnością bajtów         |
| `0004372425,0042,44873`  | format Wiegand — numer w pierwszym polu    |
| `04:A2:2B:9C:11:44:80`   | 7-bajtowy UID z separatorami               |

Karta zapisana po odczycie w jednym trybie **odnajduje się po odczycie
w drugim** — wyszukiwanie sprawdza obie kolejności bajtów. W historii zapisuje
się kanoniczny numer karty, a surowy odczyt zostaje w osobnym polu.

Tryb interpretacji ustawia się w zakładce **Ustawienia** (`AUTO` / `DEC` / `HEX`).
Jeśli nie wiesz, w jakim trybie pracuje Twój czytnik, użyj **Diagnostyki
odczytu**: pokaże dokładnie wysłane znaki, tempo pisania oraz wynik
interpretacji w każdym z trzech trybów.

## Uruchomienie

```bash
git clone https://github.com/Ziut3k-dev/RFID-Reader-App.git
cd RFID-Reader-App
npm install
npm start
```

`npm start` buduje interfejs i uruchamia aplikację. Podczas pracy nad kodem:

```bash
npm run dev
```

— serwer Vite z podmianą modułów na gorąco plus Electron.

Sam interfejs (bez procesu głównego, dane w `localStorage`) można podejrzeć
przez `npm run dev:web` — wygodne przy pracy nad wyglądem.

## Funkcje

**Skanowanie** — duży, czytelny z odległości wynik odczytu: dostęp przyznany /
odmówiony / karta nieznana, dane właściciela, wszystkie reprezentacje UID,
sygnał dźwiękowy. Nieznaną kartę można dopisać do bazy bez opuszczania panelu;
odczyt, który to zainicjował, dostaje wsteczną korektę w historii. Jest też pole
do ręcznego wpisania numeru (np. z etykiety karty).

**Karty** — baza kart: nazwa, właściciel, rola, blokada, zakres ważności,
notatka, licznik odczytów, szukajka, eksport CSV.

**Historia** — dziennik odczytów z filtrami (wynik, zakres dat, wyszukiwanie
tekstowe), stronicowaniem i eksportem CSV.

**Ustawienia** — tryb interpretacji numeru, reguła dla nieznanej karty
(odmowa / tryb nauki), nazwa stanowiska, okno blokady powtórnego odczytu, limit
historii, dźwięk, wykrywanie czytnika na liście USB i diagnostyka odczytu.

## Reguły dostępu

Kolejność sprawdzania (`shared/core.js`, funkcja `evaluate`):

1. **powtórny odczyt** — karta trzymana przy czytniku generuje serię odczytów;
   powtórki w oknie blokady (domyślnie 3 s) są pomijane i nie trafiają do historii,
2. **karta nieznana** — odmowa albo automatyczny zapis, zależnie od ustawienia,
3. **karta zablokowana** — odmowa,
4. **poza zakresem ważności** — odmowa z podaniem daty,
5. w przeciwnym razie **dostęp przyznany**.

## Dane

Jeden plik JSON zapisywany atomowo (plik tymczasowy + `rename`), bez zależności
natywnych:

* wersja spakowana — katalog danych aplikacji
  (macOS: `~/Library/Application Support/rfid-scanner/rfid-data.json`),
* uruchomienie z repozytorium — `data/rfid-data.json`.

Ścieżkę pokazuje zakładka Ustawienia, a menu **Plik → Pokaż plik bazy danych**
otwiera go w systemowym menedżerze plików. Uszkodzony plik nie jest nadpisywany
po cichu — trafia na bok jako `*.corrupt-<czas>`.

## Struktura projektu

```
shared/      logika niezależna od środowiska
  core.js      parsowanie numeru karty + reguły dostępu
  store.js     magazyn danych (wymienna warstwa zapisu)
  service.js   przetwarzanie odczytu, zapis kart, diagnostyka
electron/
  main.js        okno, menu, IPC, CSP
  preload.cjs    mostek do procesu renderującego
  persistence.js zapis do pliku JSON
  reader.js      wykrywanie czytnika na liście USB
src/         interfejs React
  hooks/useKeyboardWedge.ts   przechwytywanie odczytu z klawiatury HID
tests/       testy logiki (node:test)
```

Reguły żyją w `shared/`, więc aplikacja Electron i podglądowy tryb
przeglądarkowy podejmują identyczne decyzje — nie ma dwóch implementacji.

## Testy

```bash
npm test        # 32 testy logiki odczytu, magazynu i reguł dostępu
npm run typecheck
```

## Wersja instalacyjna

```bash
npm run dist:mac     # dmg + zip (arm64, x64)
npm run dist:win     # instalator NSIS + portable (x64, arm64)
npm run dist:linux   # AppImage + deb + tar.gz (x64, arm64)
npm run pack         # tylko rozpakowana aplikacja — szybkie sprawdzenie
npm run icon         # przebuduj build/icon.png z build/icon.svg
```

Wynik trafia do katalogu `release/`. Konfiguracja jest w
[`electron-builder.yml`](../electron-builder.yml). Każdy format instalatora
najpewniej powstaje na swoim systemie (`.dmg` wymaga macOS, `.exe` Windowsa),
dlatego wydania buduje GitHub Actions.

## Wydania przez GitHub Actions

[`release.yml`](../.github/workflows/release.yml) buduje wszystkie trzy systemy
na własnych runnerach i dołącza pliki do **roboczego szkicu** wydania:

```bash
# najpierw podnieś "version" w package.json — workflow porówna ją z tagiem
git tag v1.0.0
git push origin v1.0.0
```

Uruchomienie ręczne z zakładki Actions tylko buduje i zostawia paczki jako
artefakty przebiegu — wydanie powstaje wyłącznie z tagu.
[`ci.yml`](../.github/workflows/ci.yml) przy każdym pushu i pull requeście
uruchamia testy, kontrolę typów i próbne spakowanie na trzech systemach.

## Skanowanie kodu

[`codeql.yml`](../.github/workflows/codeql.yml) uruchamia CodeQL z zestawem
`security-and-quality` przy każdym pushu, pull requeście i raz w tygodniu.
**Jednorazowe ustawienie w repozytorium:** GitHub włącza publicznym repozytoriom
własną domyślną konfigurację skanowania, która odrzuca wyniki z workflow — krok
analizy kończy się wtedy błędem, mimo że sam skan przebiega poprawnie. Wyłącz ją
w *Settings → Code security → Code scanning → CodeQL analysis → Disable*, albo
usuń `codeql.yml` i zostaw domyślną konfigurację GitHuba (skanowanie działa,
tylko bez kontroli nad zestawem reguł i harmonogramem).

[Dependabot](../.github/dependabot.yml) raz w tygodniu proponuje aktualizacje
zależności i akcji. Electron jest zależnością deweloperską, ale trafia do
gotowej paczki, więc jego podatności dotyczą użytkownika aplikacji.

## Podpisywanie commitów i tagów

Commity i tagi są podpisywane kluczem SSH, dzięki czemu GitHub oznacza je jako
**Verified**. To co innego niż podpisywanie instalatorów niżej: tu chodzi o to,
kto jest autorem commita, tam — kto zbudował plik wykonywalny.

Konfiguracja na świeżym klonie:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_signing -C "ty@example.com (git signing)"
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519_signing.pub
git config commit.gpgsign true
git config tag.gpgsign true
```

Klucz **publiczny** dodaj na GitHubie w *Settings → SSH and GPG keys →
New SSH key*, wybierając typ **Signing Key** — klucz uwierzytelniający sam
z siebie nie sprawia, że commity stają się Verified.

Do lokalnej weryfikacji git musi wiedzieć, którym kluczom ufać:

```bash
printf 'ty@example.com namespaces="git" %s\n' "$(cut -d' ' -f1,2 ~/.ssh/id_ed25519_signing.pub)" \
  > ~/.ssh/allowed_signers
git config gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
git log --show-signature -1
git tag -v v1.0.0
```

## Podpisywanie instalatorów

Paczki nie są podpisane, więc wydanie nie wymaga żadnych sekretów. Aby podpisać
build macOS, usuń `identity: null` z `electron-builder.yml` i ustaw sekrety
`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`. Dla Windowsa wystarczą `CSC_LINK` i `CSC_KEY_PASSWORD`
z certyfikatem Authenticode.

Bez podpisu przy pierwszym uruchomieniu system pokaże ostrzeżenie: na macOS
kliknij aplikację prawym przyciskiem i wybierz „Otwórz”, w Windowsie w oknie
SmartScreen wybierz „Więcej informacji” → „Uruchom mimo to”.

## Rozwiązywanie problemów

**Karta nie jest odczytywana** — sprawdź, czy okno aplikacji jest aktywne
i czy wskaźnik pokazuje „Nasłuch aktywny”. W zakładce Ustawienia uruchom
Diagnostykę odczytu: jeśli nie widzisz żadnych znaków, czytnik nie wysyła
naciśnięć klawiszy (spróbuj innego portu USB albo sprawdź, czy karta jest
standardu ISO14443A — czytnik nie odczyta kart 125 kHz).

**Numer się nie zgadza z etykietą karty** — czytnik pracuje w innym trybie niż
ustawiony. Diagnostyka pokaże, który tryb daje numer zgodny z etykietą; ustaw go
w Ustawieniach.

**Ta sama karta zapisała się dwa razy** — starsze wpisy mogły powstać przy
odczytach w różnych trybach. Usuń duplikat w zakładce Karty; kolejne odczyty
będą już dopasowywane do jednej karty.

**Jeden odczyt daje kilka wpisów w historii** — zwiększ okno blokady powtórnego
odczytu w Ustawieniach.

## Bezpieczeństwo

Podatności zgłaszaj prywatnie — zasady i opis modelu bezpieczeństwa (brak
sieci, dane lokalne bez szyfrowania, niepodpisane paczki) są
w [SECURITY.md](../SECURITY.md).

## Licencja

[MIT](../LICENSE) — wolno wszystko, wystarczy zachować informację o autorstwie,
bez żadnej gwarancji.
