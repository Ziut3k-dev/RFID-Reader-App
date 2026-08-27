import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Scan } from '../types';
import { DECISION_LABEL, formatDateTime } from '../lib/format';

const PAGE = 100;

interface Props {
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

export function HistoryPanel({ notify }: Props) {
  const [rows, setRows] = useState<Scan[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [decision, setDecision] = useState('');
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.listScans({ limit, decision, q: query, from, to });
      setRows(res.rows);
      setTotal(res.total);
    } catch (err) {
      notify(`Nie udało się wczytać historii: ${(err as Error).message}`, 'error');
    }
  }, [decision, from, limit, notify, query, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = async () => {
    try {
      const res = await api.exportCsv('scans');
      if (res.canceled) return;
      notify(res.filePath ? `Zapisano ${res.filePath}` : 'Plik CSV pobrany', 'success');
    } catch (err) {
      notify(`Eksport nie powiódł się: ${(err as Error).message}`, 'error');
    }
  };

  const clear = async () => {
    if (!window.confirm('Usunąć całą historię odczytów? Tej operacji nie można cofnąć.')) return;
    try {
      await api.clearScans();
      notify('Historia wyczyszczona', 'success');
      await load();
    } catch (err) {
      notify(`Nie udało się wyczyścić historii: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h2>Historia odczytów</h2>
          <p className="page__sub">
            {total} {total === 1 ? 'odczyt' : 'odczytów'} spełnia kryteria
            {rows.length < total && ` · pokazano ${rows.length}`}
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--ghost" onClick={() => void exportCsv()}>
            Eksport CSV
          </button>
          <button className="btn btn--ghost btn--danger" onClick={() => void clear()}>
            Wyczyść
          </button>
        </div>
      </header>

      <div className="filters">
        <label>
          Wynik
          <select value={decision} onChange={(e) => setDecision(e.target.value)}>
            <option value="">wszystkie</option>
            <option value="granted">dostęp przyznany</option>
            <option value="denied">dostęp odmówiony</option>
            <option value="unknown">karta nieznana</option>
          </select>
        </label>
        <label>
          Od dnia
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Do dnia
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="grow">
          Szukaj
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="UID, nazwa karty, właściciel, stanowisko…"
            spellCheck={false}
          />
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <h3>Brak odczytów</h3>
          <p>Historia zapełni się po pierwszym zbliżeniu karty do czytnika.</p>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Czas</th>
                  <th>Karta</th>
                  <th>Właściciel</th>
                  <th>UID</th>
                  <th>Wynik</th>
                  <th>Powód</th>
                  <th>Stanowisko</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((scan) => (
                  <tr key={scan.id}>
                    <td className="nowrap small">{formatDateTime(scan.ts)}</td>
                    <td className="strong">{scan.cardLabel || <span className="muted">nieznana</span>}</td>
                    <td>{scan.cardOwner || <span className="muted">—</span>}</td>
                    <td>
                      <code title={`surowy odczyt: ${scan.uidRaw}`}>{scan.uidHex}</code>
                    </td>
                    <td>
                      <span className={`badge badge--${scan.decision}`}>
                        {DECISION_LABEL[scan.decision]}
                      </span>
                    </td>
                    <td className="small">{scan.reason}</td>
                    <td className="small">{scan.station}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length < total && (
            <div className="more">
              <button className="btn btn--ghost" onClick={() => setLimit((l) => l + PAGE)}>
                Pokaż kolejne {Math.min(PAGE, total - rows.length)}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
