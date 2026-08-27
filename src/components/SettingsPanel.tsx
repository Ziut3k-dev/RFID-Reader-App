import { useCallback, useEffect, useState } from 'react';
import { api, isElectron } from '../api';
import { useKeyboardWedge, type WedgeMeta } from '../hooks/useKeyboardWedge';
import type { AppInfo, Inspection, ReaderInfo, Settings, Uid, UidFormat } from '../types';

interface Props {
  settings: Settings;
  onSave: (patch: Partial<Settings>) => Promise<Settings>;
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

const FORMAT_HELP: Record<UidFormat, string> = {
  auto: 'Rozpoznawaj sam: 10 cyfr → tryb dziesiętny, 8 znaków → HEX. Pasuje do fabrycznych ustawień czytnika.',
  dec: 'Zawsze traktuj odczyt jako liczbę dziesiętną (czytnik przełączony na tryb DEC).',
  hex: 'Zawsze traktuj odczyt jako zapis HEX (czytnik przełączony na tryb HEX).',
};

export function SettingsPanel({ settings, onSave, notify }: Props) {
  const [form, setForm] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const [reader, setReader] = useState<ReaderInfo | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [detecting, setDetecting] = useState(false);

  // Diagnostyka: podgląd tego, co dokładnie wysyła czytnik.
  const [diagOn, setDiagOn] = useState(false);
  const [diag, setDiag] = useState<{ inspection: Inspection; meta: WedgeMeta } | null>(null);

  useEffect(() => setForm(settings), [settings]);

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await api.appInfo());
      } catch {
        /* informacje o wersji są opcjonalne */
      }
    })();
  }, []);

  const detect = useCallback(async () => {
    setDetecting(true);
    try {
      setReader(await api.detectReaders());
    } catch (err) {
      notify(`Wykrywanie nie powiodło się: ${(err as Error).message}`, 'error');
    } finally {
      setDetecting(false);
    }
  }, [notify]);

  useEffect(() => {
    void detect();
  }, [detect]);

  useKeyboardWedge({
    enabled: diagOn,
    onScan: (raw, meta) => {
      void (async () => {
        try {
          setDiag({ inspection: await api.inspect(raw), meta });
        } catch (err) {
          notify(`Diagnostyka: ${(err as Error).message}`, 'error');
        }
      })();
    },
  });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(form);
      notify('Ustawienia zapisane', 'success');
    } catch (err) {
      notify(`Nie udało się zapisać ustawień: ${(err as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h2>Ustawienia</h2>
          <p className="page__sub">Czytnik, reguły dostępu i diagnostyka odczytu</p>
        </div>
      </header>

      <div className="settings">
        <form className="card" onSubmit={save}>
          <h3 className="card__title">Reguły odczytu</h3>

          <fieldset className="radio-set">
            <legend>Format numeru karty</legend>
            {(['auto', 'dec', 'hex'] as UidFormat[]).map((fmt) => (
              <label key={fmt} className={`radio ${form.uidFormat === fmt ? 'radio--on' : ''}`}>
                <input
                  type="radio"
                  name="uidFormat"
                  checked={form.uidFormat === fmt}
                  onChange={() => setForm({ ...form, uidFormat: fmt })}
                />
                <span>
                  <strong>{fmt.toUpperCase()}</strong>
                  <small>{FORMAT_HELP[fmt]}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset className="radio-set">
            <legend>Nieznana karta</legend>
            <label className={`radio ${form.unknownPolicy === 'deny' ? 'radio--on' : ''}`}>
              <input
                type="radio"
                name="unknownPolicy"
                checked={form.unknownPolicy === 'deny'}
                onChange={() => setForm({ ...form, unknownPolicy: 'deny' })}
              />
              <span>
                <strong>Odmów dostępu</strong>
                <small>Odczyt trafia do historii, kartę dopisujesz ręcznie. Tryb pracy normalnej.</small>
              </span>
            </label>
            <label className={`radio ${form.unknownPolicy === 'enroll' ? 'radio--on' : ''}`}>
              <input
                type="radio"
                name="unknownPolicy"
                checked={form.unknownPolicy === 'enroll'}
                onChange={() => setForm({ ...form, unknownPolicy: 'enroll' })}
              />
              <span>
                <strong>Dopisz automatycznie</strong>
                <small>Tryb nauki: wygodny przy wprowadzaniu pliku kart, potem warto go wyłączyć.</small>
              </span>
            </label>
          </fieldset>

          <div className="form-grid">
            <label>
              Nazwa stanowiska
              <input
                value={form.station}
                onChange={(e) => setForm({ ...form, station: e.target.value })}
                placeholder="np. brama-1"
              />
              <small className="hint">Zapisywana przy każdym odczycie w historii.</small>
            </label>
            <label>
              Blokada powtórnego odczytu (s)
              <input
                type="number"
                min={0}
                max={120}
                value={form.debounceSeconds}
                onChange={(e) => setForm({ ...form, debounceSeconds: Number(e.target.value) })}
              />
              <small className="hint">
                Karta trzymana przy czytniku generuje serię odczytów. Powtórki w tym czasie są
                pomijane i nie trafiają do historii.
              </small>
            </label>
            <label>
              Limit historii (odczytów)
              <input
                type="number"
                min={100}
                step={100}
                value={form.maxScans}
                onChange={(e) => setForm({ ...form, maxScans: Number(e.target.value) })}
              />
              <small className="hint">Po przekroczeniu limitu najstarsze odczyty są usuwane.</small>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.sound}
                onChange={(e) => setForm({ ...form, sound: e.target.checked })}
              />
              Sygnał dźwiękowy przy odczycie
            </label>
          </div>

          <div className="card__actions">
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Zapisywanie…' : 'Zapisz ustawienia'}
            </button>
          </div>
        </form>

        <div className="card">
          <h3 className="card__title">Czytnik</h3>
          <p className="card__lead">
            Czytniki 13,56 MHz tej klasy (ProRock / Sycreader, ISO14443A, S50/S70) pracują jako
            klawiatura USB HID: po zbliżeniu karty „wpisują” jej numer i wysyłają Enter. Nie
            wymagają sterownika ani portu szeregowego — aplikacja przechwytuje te znaki.
          </p>

          <button className="btn btn--ghost" onClick={() => void detect()} disabled={detecting}>
            {detecting ? 'Szukanie…' : 'Odśwież listę urządzeń USB'}
          </button>

          {reader && (
            <div className="reader-info">
              {reader.matches.length > 0 ? (
                <ul className="devices">
                  {reader.matches.map((d, i) => (
                    <li key={i} className="devices__hit">
                      <strong>{d.name}</strong>
                      <span>
                        {d.vendor}
                        {d.vid !== null && ` · VID 0x${d.vid.toString(16).toUpperCase().padStart(4, '0')}`}
                        {d.pid !== null && ` PID 0x${d.pid.toString(16).toUpperCase().padStart(4, '0')}`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="card__note">Na liście USB nie ma urządzenia wyglądającego na czytnik.</p>
              )}
              <p className="card__note">{reader.hint}</p>
              {reader.devices.length > 0 && (
                <details>
                  <summary>Wszystkie urządzenia USB ({reader.devices.length})</summary>
                  <ul className="devices devices--plain">
                    {reader.devices.map((d, i) => (
                      <li key={i}>
                        {d.name} {d.vendor && <span className="muted">· {d.vendor}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="card__title">Diagnostyka odczytu</h3>
          <p className="card__lead">
            Włącz podgląd i zbliż kartę. Zobaczysz dokładnie te znaki, które wysłał czytnik, oraz
            wynik interpretacji w każdym z trzech trybów — po tym poznasz, który tryb ustawić.
            Odczyty w tym trybie nie trafiają do historii.
          </p>

          <button
            className={`btn ${diagOn ? 'btn--danger' : 'btn--primary'}`}
            onClick={() => {
              setDiagOn((v) => !v);
              setDiag(null);
            }}
          >
            {diagOn ? 'Zatrzymaj podgląd' : 'Włącz podgląd'}
          </button>

          {diagOn && !diag && <p className="card__note pulse">Czekam na kartę…</p>}

          {diag && (
            <div className="diag">
              <div className="diag__raw">
                <span>Czytnik wysłał</span>
                <code>{diag.inspection.raw}</code>
              </div>
              <p className="card__note">
                {diag.meta.chars} znaków, średnio {diag.meta.avgGapMs} ms na znak, zakończone{' '}
                {diag.meta.viaEnter ? 'Enterem' : 'przerwą w pisaniu'} —{' '}
                {diag.meta.machineTyped ? 'tempo typowe dla czytnika' : 'tempo typowe dla pisania na klawiaturze'}.
              </p>
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>Tryb</th>
                    <th>UID (HEX)</th>
                    <th>Dziesiętnie</th>
                    <th>Odwrócone bajty</th>
                  </tr>
                </thead>
                <tbody>
                  {(['auto', 'dec', 'hex'] as UidFormat[]).map((fmt) => {
                    const value = diag.inspection[fmt] as Uid | { error: string };
                    const isActive = diag.inspection.activeFormat === fmt;
                    return (
                      <tr key={fmt} className={isActive ? 'row--active' : ''}>
                        <td className="strong">
                          {fmt.toUpperCase()} {isActive && <span className="chip chip--ok">używany</span>}
                        </td>
                        {'error' in value ? (
                          <td colSpan={3} className="muted">{value.error}</td>
                        ) : (
                          <>
                            <td><code>{value.pretty}</code></td>
                            <td>{value.dec10}</td>
                            <td><code>{value.hexReversed}</code></td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="card__title">O aplikacji</h3>
          {info && (
            <dl className="kv">
              <div><dt>Wersja</dt><dd>{info.version}</dd></div>
              <div><dt>Środowisko</dt><dd>{isElectron ? `Electron ${info.electron} · Chromium ${info.chrome}` : 'przeglądarka (tryb podglądu)'}</dd></div>
              {isElectron && <div><dt>Node</dt><dd>{info.node}</dd></div>}
              <div><dt>Platforma</dt><dd>{info.platform}</dd></div>
              <div><dt>Baza danych</dt><dd className="break">{info.dataFile}</dd></div>
            </dl>
          )}
          {!isElectron && (
            <p className="card__note">
              To okno działa bez procesu głównego Electrona, więc dane zapisują się w localStorage
              przeglądarki. Uruchom <code>npm run dev</code>, aby pracować na pliku bazy.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
