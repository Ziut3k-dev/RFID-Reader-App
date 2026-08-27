import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useKeyboardWedge, type WedgeMeta } from '../hooks/useKeyboardWedge';
import { playFeedback } from '../lib/sound';
import { DECISION_LABEL, formatTime } from '../lib/format';
import type { Card, Scan, ScanResult, Settings, Stats } from '../types';
import { EnrollForm } from './EnrollForm';

interface Props {
  settings: Settings;
  stats: Stats | null;
  onStatsChange: () => void;
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

export function ScanPanel({ settings, stats, onStatsChange, notify }: Props) {
  const [armed, setArmed] = useState(true);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [meta, setMeta] = useState<WedgeMeta | null>(null);
  const [recent, setRecent] = useState<Scan[]>([]);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const flashRef = useRef<HTMLDivElement>(null);

  const loadRecent = useCallback(async () => {
    try {
      const { rows } = await api.listScans({ limit: 9 });
      setRecent(rows);
    } catch (err) {
      notify(`Nie udało się odczytać historii: ${(err as Error).message}`, 'error');
    }
  }, [notify]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const handleScan = useCallback(
    async (raw: string, scanMeta?: WedgeMeta) => {
      setBusy(true);
      setMeta(scanMeta ?? null);
      try {
        const res = await api.scan(raw, settings.station);
        setResult(res);
        if (!res.ok) {
          notify(res.error || 'Nie rozpoznano odczytu', 'error');
          return;
        }
        if (settings.sound) playFeedback(res.decision!);
        // Krótkie mignięcie ramki — potwierdzenie odczytu widoczne kątem oka.
        flashRef.current?.animate(
          [{ opacity: 0.85 }, { opacity: 0 }],
          { duration: 420, easing: 'ease-out' },
        );
        if (res.decision !== 'duplicate') {
          await loadRecent();
          onStatsChange();
        }
      } catch (err) {
        notify(`Błąd odczytu: ${(err as Error).message}`, 'error');
      } finally {
        setBusy(false);
      }
    },
    [loadRecent, notify, onStatsChange, settings.sound, settings.station],
  );

  useKeyboardWedge({
    enabled: armed,
    onScan: (raw, wedgeMeta) => void handleScan(raw, wedgeMeta),
    gapMs: 220,
  });

  const onManualSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const raw = manual.trim();
    if (!raw) return;
    setManual('');
    void handleScan(raw);
  };

  const onEnrolled = (card: Card) => {
    setResult((prev) =>
      prev ? { ...prev, card, decision: 'granted', reason: 'karta dopisana do bazy' } : prev,
    );
    void loadRecent();
    onStatsChange();
    notify(`Karta zapisana: ${card.label || card.uidHex}`, 'success');
  };

  const decision = result?.ok ? result.decision! : null;

  return (
    <div className="scan">
      <section className={`reader ${decision ? `reader--${decision}` : ''}`}>
        <div className="reader__flash" ref={flashRef} aria-hidden="true" />

        <header className="reader__head">
          <button
            className={`listen ${armed ? 'listen--on' : 'listen--off'}`}
            onClick={() => setArmed((v) => !v)}
            title="Przechwytywanie klawiatury — czytnik HID wpisuje numer karty jak klawiaturą"
          >
            <span className="listen__dot" />
            {armed ? 'Nasłuch aktywny' : 'Nasłuch wyłączony'}
          </button>
          {busy && <span className="reader__busy">przetwarzanie…</span>}
          {meta && (
            <span className="reader__meta" title="Tempo pisania rozpoznane przy ostatnim odczycie">
              {meta.chars} znaków · {meta.avgGapMs} ms/znak ·{' '}
              {meta.machineTyped ? 'czytnik' : 'wpisane ręcznie'} ·{' '}
              {meta.viaEnter ? 'Enter' : 'przerwa'}
            </span>
          )}
        </header>

        {!result && (
          <div className="reader__idle">
            <div className="reader__idle-icon" aria-hidden="true">
              <svg viewBox="0 0 64 64" width="72" height="72" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <rect x="8" y="18" width="34" height="24" rx="4" opacity=".5" />
                <path d="M48 24a10 10 0 0 1 0 16" />
                <path d="M53 19a17 17 0 0 1 0 26" opacity=".55" />
                <path d="M58 14a24 24 0 0 1 0 36" opacity=".28" />
              </svg>
            </div>
            <h2>Zbliż kartę do czytnika</h2>
            <p>
              Czytnik zgłasza się w systemie jako klawiatura USB — wystarczy, że to okno jest
              aktywne. Numer karty zostanie odczytany automatycznie.
            </p>
          </div>
        )}

        {result && !result.ok && (
          <div className="verdict verdict--error">
            <div className="verdict__badge">Nie rozpoznano</div>
            <p className="verdict__reason">{result.error}</p>
            <code className="verdict__raw">odczyt: {result.raw || '—'}</code>
          </div>
        )}

        {result?.ok && (
          <div className={`verdict verdict--${decision}`}>
            <div className="verdict__badge">{DECISION_LABEL[decision!]}</div>

            <div className="verdict__identity">
              {result.card ? (
                <>
                  <div className="verdict__name">{result.card.label || 'Karta bez nazwy'}</div>
                  <div className="verdict__owner">
                    {result.card.owner || 'brak właściciela'} · rola {result.card.role}
                    {result.card.scanCount !== undefined && ` · odczytów: ${result.card.scanCount}`}
                  </div>
                </>
              ) : (
                <div className="verdict__name verdict__name--muted">Karta nie jest w bazie</div>
              )}
            </div>

            <p className="verdict__reason">{result.reason}</p>

            <dl className="uid">
              <div>
                <dt>UID (HEX)</dt>
                <dd className="uid__main">{result.uid!.pretty}</dd>
              </div>
              <div>
                <dt>Dziesiętnie</dt>
                <dd>{result.uid!.dec10}</dd>
              </div>
              <div>
                <dt>Odwrócone bajty</dt>
                <dd>{result.uid!.hexReversed}</dd>
              </div>
              <div>
                <dt>Długość / źródło</dt>
                <dd>
                  {result.uid!.bytes} B · {result.uid!.source.toUpperCase()}
                </dd>
              </div>
            </dl>

            {result.at && <div className="verdict__time">odczyt {formatTime(result.at)}</div>}

            {decision === 'unknown' && result.uid && (
              <EnrollForm uid={result.uid} onEnrolled={onEnrolled} notify={notify} />
            )}
          </div>
        )}

        <form className="manual" onSubmit={onManualSubmit}>
          <label htmlFor="manual-uid">Wpisz numer ręcznie</label>
          <div className="manual__row">
            <input
              id="manual-uid"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="np. 0004372425 albo 0042B7C9"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="btn btn--ghost" disabled={!manual.trim()}>
              Sprawdź
            </button>
          </div>
          <p className="manual__hint">
            Przydaje się, gdy karty nie ma pod ręką albo trzeba sprawdzić numer z etykiety.
            Pole nie przechwytuje odczytów czytnika — te trafiają wprost do panelu wyżej.
          </p>
        </form>
      </section>

      <aside className="side">
        <div className="tiles">
          <Tile label="Dzisiaj odczytów" value={stats?.today ?? 0} />
          <Tile label="Unikalnych kart" value={stats?.uniqueToday ?? 0} />
          <Tile label="Przyznane" value={stats?.granted ?? 0} tone="ok" />
          <Tile label="Odmowy" value={(stats?.denied ?? 0) + (stats?.unknown ?? 0)} tone="bad" />
        </div>

        <div className="panel">
          <h3 className="panel__title">Ostatnie odczyty</h3>
          {recent.length === 0 && <p className="panel__empty">Brak odczytów.</p>}
          <ul className="feed">
            {recent.map((scan) => (
              <li key={scan.id} className={`feed__item feed__item--${scan.decision}`}>
                <span className="feed__time">{formatTime(scan.ts)}</span>
                <span className="feed__who">{scan.cardLabel || scan.uidHex}</span>
                <span className="feed__tag">{DECISION_LABEL[scan.decision]}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'bad' }) {
  return (
    <div className={`tile ${tone ? `tile--${tone}` : ''}`}>
      <div className="tile__value">{value}</div>
      <div className="tile__label">{label}</div>
    </div>
  );
}
