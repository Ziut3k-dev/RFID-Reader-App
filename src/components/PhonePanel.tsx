import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import type { BridgeStatus, Settings } from '../types';

interface Props {
  settings: Settings;
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

/**
 * Parowanie telefonu jako skanera: aplikacja uruchamia serwer w sieci lokalnej
 * i pokazuje kod QR z adresem. Telefon po zeskanowaniu otwiera stronę skanera,
 * a jego odczyty przechodzą przez te same reguły dostępu co odczyty z czytnika.
 */
export function PhonePanel({ settings, notify }: Props) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [qr, setQr] = useState<string>('');
  const [selected, setSelected] = useState(0);
  const [port, setPort] = useState(String(settings.bridgePort));
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.bridgeStatus());
    } catch (err) {
      notify(`Nie udało się odczytać stanu serwera: ${(err as Error).message}`, 'error');
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const url = status?.urls[selected] ?? '';

  useEffect(() => {
    if (!url) {
      setQr('');
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: { dark: '#0f1420', light: '#ffffff' },
    })
      .then((data) => {
        if (!cancelled) setQr(data);
      })
      .catch((err) => notify(`Nie udało się narysować kodu QR: ${err.message}`, 'error'));
    return () => {
      cancelled = true;
    };
  }, [notify, url]);

  const run = async (action: () => Promise<BridgeStatus>, message?: string) => {
    setBusy(true);
    try {
      const next = await action();
      setStatus(next);
      setSelected(0);
      if (next.error) notify(next.error, 'error');
      else if (message) notify(message, 'success');
    } catch (err) {
      notify(`Operacja nie udała się: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h2>Telefon jako skaner</h2>
          <p className="page__sub">
            Serwer w sieci lokalnej i kod QR do sparowania — telefon skanuje kody kamerą,
            a odczyty trafiają wprost do tej aplikacji
          </p>
        </div>
        <div className="page__actions">
          {status?.running ? (
            <button className="btn btn--danger" disabled={busy} onClick={() => void run(api.bridgeStop, 'Serwer zatrzymany')}>
              Zatrzymaj serwer
            </button>
          ) : (
            <button className="btn btn--primary" disabled={busy} onClick={() => void run(api.bridgeStart, 'Serwer uruchomiony')}>
              Uruchom serwer
            </button>
          )}
        </div>
      </header>

      <div className="settings">
        <div className="card">
          <h3 className="card__title">Parowanie</h3>

          {!status?.running && (
            <p className="card__lead">
              {status?.error
                ? status.error
                : 'Serwer jest wyłączony. Uruchom go, aby dostać kod QR do zeskanowania telefonem.'}
            </p>
          )}

          {status?.running && (
            <>
              <div className="pairing">
                {qr ? (
                  <img className="pairing__qr" src={qr} alt={`Kod QR z adresem ${url}`} width={320} height={320} />
                ) : (
                  <div className="pairing__qr pairing__qr--empty">rysowanie kodu…</div>
                )}
                <ol className="pairing__steps">
                  <li>Otwórz aplikację Kamera na iPhonie i skieruj ją na ten kod.</li>
                  <li>Dotknij podpowiedzi, która się pojawi — Safari otworzy stronę skanera.</li>
                  <li>Telefon i komputer muszą być w tej samej sieci Wi-Fi.</li>
                </ol>
              </div>

              {status.urls.length > 1 && (
                <label className="pairing__pick">
                  Adres sieciowy
                  <select value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
                    {status.urls.map((u, i) => (
                      <option key={u} value={i}>
                        {status.addresses[i]?.name} — {status.addresses[i]?.address}
                      </option>
                    ))}
                  </select>
                  <small className="hint">
                    Komputer ma kilka adresów (np. Wi-Fi i VPN). Jeśli telefon nie może się połączyć,
                    wybierz inny.
                  </small>
                </label>
              )}

              <div className="pairing__url">
                <code>{url}</code>
              </div>

              <div className="card__actions">
                <button
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={() => void run(api.bridgeRegenerateToken, 'Nowy kod parowania — zeskanuj go ponownie')}
                >
                  Nowy kod parowania
                </button>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <h3 className="card__title">Co telefon potrafi</h3>
          <p className="card__lead">
            Strona na telefonie przyjmuje <strong>numer wpisany z etykiety karty</strong> i pokazuje
            wynik. Odczyt przechodzi te same reguły co karta zbliżona do czytnika USB i trafia do
            historii ze stanowiskiem <code>{settings.station}/telefon</code>.
          </p>
          <p className="card__note">
            <strong>Czego nie potrafi:</strong> telefonem nie da się odczytać karty zbliżeniowej —
            przeglądarki na iPhonie nie mają dostępu do NFC (Safari nie implementuje Web NFC, to API
            istnieje tylko w Chrome na Androidzie). Kartę odczytuje czytnik USB przy komputerze.
            Odczyt kart wbudowanym czytnikiem NFC iPhone'a wymagałby osobnej aplikacji natywnej.
          </p>
          <p className="card__note">
            Karty oznaczone kodem QR z adresem <code>/q/&lt;sekret&gt;/&lt;numer&gt;</code> rejestrują
            się po zeskanowaniu systemową aplikacją Kamera — bez otwierania tej strony.
          </p>
        </div>

        <div className="card">
          <h3 className="card__title">Bezpieczeństwo i port</h3>
          <p className="card__lead">
            Serwer nasłuchuje tylko wtedy, gdy jest włączony, i wymaga sekretu z adresu sparowania.
            <strong> Kto ma zdjęcie kodu QR, ma dostęp do rejestrowania odczytów</strong> — po
            zakończeniu pracy warto serwer zatrzymać albo wygenerować nowy kod. Połączenie nie jest
            szyfrowane, więc trzymaj je w zaufanej sieci.
          </p>

          <div className="form-grid">
            <label>
              Port serwera
              <input
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
              <small className="hint">
                Porty poniżej 1024 wymagają uprawnień administratora. Zmiana wymaga restartu serwera.
              </small>
            </label>
            <label className="checkbox">
              <button
                className="btn btn--ghost"
                disabled={busy || !status?.running}
                onClick={() => void run(() => api.bridgeRestart(Number(port)), `Serwer działa na porcie ${port}`)}
              >
                Zastosuj port
              </button>
            </label>
          </div>

          {status && (
            <dl className="kv">
              <div>
                <dt>Stan</dt>
                <dd>{status.running ? `nasłuchuje na porcie ${status.port}` : 'zatrzymany'}</dd>
              </div>
              <div>
                <dt>Adresy</dt>
                <dd className="break">
                  {status.addresses.length
                    ? status.addresses.map((a) => `${a.name} ${a.address}`).join(', ')
                    : 'brak adresu w sieci lokalnej'}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}
