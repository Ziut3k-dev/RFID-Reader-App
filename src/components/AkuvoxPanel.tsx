import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type {
  AkuvoxStatus, AkuvoxTestResult, Card, RemoteItem, RequestLogEntry,
} from '../types';
import { formatDateTime } from '../lib/format';

interface Props {
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

/**
 * Integracja z chmurą Akuvox (akubela OpenAPI).
 *
 * Układ paneli odpowiada kolejności pracy: najpierw połączenie, potem wybór
 * obiektu → mieszkania → mieszkańca, na końcu przypisanie karty. Dziennik
 * zapytań jest na dole, bo przydaje się tylko wtedy, gdy coś nie działa.
 */
export function AkuvoxPanel({ notify }: Props) {
  const [status, setStatus] = useState<AkuvoxStatus | null>(null);
  const [test, setTest] = useState<AkuvoxTestResult | null>(null);
  const [busy, setBusy] = useState('');

  // formularz połączenia
  const [region, setRegion] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [username, setUsername] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [password, setPassword] = useState('');
  const [cardFormat, setCardFormat] = useState('dec');
  const [dryRun, setDryRun] = useState(false);

  // wybór celu
  const [sites, setSites] = useState<RemoteItem[]>([]);
  const [apartments, setApartments] = useState<RemoteItem[]>([]);
  const [residents, setResidents] = useState<RemoteItem[]>([]);
  const [siteId, setSiteId] = useState('');
  const [apartmentId, setApartmentId] = useState('');
  const [residentId, setResidentId] = useState('');

  const [cards, setCards] = useState<Card[]>([]);
  const [cardId, setCardId] = useState<number | ''>('');
  const [log, setLog] = useState<RequestLogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const next = await api.akuvoxStatus();
      setStatus(next);
      setRegion(next.region);
      setBaseUrl(next.baseUrl);
      setClientId(next.clientId);
      setUsername(next.username);
      setCardFormat(next.cardFormat);
      setDryRun(next.dryRun);
    } catch (err) {
      notify(`Nie udało się odczytać stanu integracji: ${(err as Error).message}`, 'error');
    }
  }, [notify]);

  const loadCards = useCallback(async () => {
    try {
      setCards(await api.listCards());
    } catch (err) {
      notify(`Nie udało się wczytać kart: ${(err as Error).message}`, 'error');
    }
  }, [notify]);

  useEffect(() => {
    void loadStatus();
    void loadCards();
  }, [loadCards, loadStatus]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    try {
      return await action();
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    await run('save', async () => {
      try {
        const next = await api.akuvoxSave({
          akuvoxRegion: region,
          akuvoxBaseUrl: baseUrl.trim(),
          akuvoxClientId: clientId.trim(),
          akuvoxUsername: username.trim(),
          akuvoxCardFormat: cardFormat,
          akuvoxDryRun: dryRun,
          akuvoxEnabled: true,
          // Puste pola sekretów zostawiają wcześniejszą wartość — inaczej
          // każde zapisanie ustawień wymagałoby wpisywania hasła od nowa.
          ...(clientSecret ? { clientSecret } : {}),
          ...(password ? { password } : {}),
        });
        setStatus(next);
        setClientSecret('');
        setPassword('');
        notify('Ustawienia integracji zapisane', 'success');
      } catch (err) {
        notify(`Nie udało się zapisać: ${(err as Error).message}`, 'error');
      }
    });
  };

  const runTest = () => run('test', async () => {
    try {
      const result = await api.akuvoxTest();
      setTest(result);
      if (result.ok) {
        setSites(result.sites ?? []);
        notify('Połączenie z chmurą działa', 'success');
      } else {
        notify(result.steps.find((s) => !s.ok)?.detail || 'Połączenie nie działa', 'error');
      }
    } catch (err) {
      notify(`Sprawdzenie nie udało się: ${(err as Error).message}`, 'error');
    }
  });

  const pickSite = async (id: string) => {
    setSiteId(id);
    setApartmentId('');
    setResidentId('');
    setApartments([]);
    setResidents([]);
    if (!id) return;
    await run('apartments', async () => {
      try {
        setApartments(await api.akuvoxApartments(id));
      } catch (err) {
        notify(`Nie udało się wczytać mieszkań: ${(err as Error).message}`, 'error');
      }
    });
  };

  const pickApartment = async (id: string) => {
    setApartmentId(id);
    setResidentId('');
    setResidents([]);
    if (!id || !siteId) return;
    await run('residents', async () => {
      try {
        const list = await api.akuvoxResidents(siteId, id);
        setResidents(list);
        if (list.length === 0) notify('To mieszkanie nie ma mieszkańców w chmurze', 'info');
      } catch (err) {
        notify(`Nie udało się wczytać mieszkańców: ${(err as Error).message}`, 'error');
      }
    });
  };

  const loadSites = () => run('sites', async () => {
    try {
      setSites(await api.akuvoxSites());
    } catch (err) {
      notify(`Nie udało się wczytać obiektów: ${(err as Error).message}`, 'error');
    }
  });

  const assign = () => run('assign', async () => {
    if (cardId === '' || !siteId || !apartmentId || !residentId) return;
    try {
      const site = sites.find((s) => s.id === siteId);
      const apartment = apartments.find((a) => a.id === apartmentId);
      const resident = residents.find((r) => r.id === residentId);
      const result = await api.akuvoxAssign(Number(cardId), {
        siteId,
        siteName: site?.name,
        apartmentId,
        apartmentName: apartment ? `${apartment.name}${apartment.extra ? ` (${apartment.extra})` : ''}` : '',
        residentId,
        residentName: resident?.name,
      });
      if (result.ok) {
        notify(`Karta przypisana w chmurze jako numer ${result.cardNumber}`, 'success');
      } else {
        notify(`Chmura odmówiła: ${result.error}`, 'error');
      }
      await loadCards();
      await loadStatus();
    } catch (err) {
      notify(`Przypisanie nie udało się: ${(err as Error).message}`, 'error');
    }
  });

  const unassign = (card: Card) => run(`unassign-${card.id}`, async () => {
    if (!window.confirm(`Odebrać kartę „${card.label || card.uidHex}” mieszkańcowi ${card.link.residentName || ''}?`)) return;
    try {
      const res = await api.akuvoxUnassign(card.id);
      notify(res.ok ? (res.message || 'Karta odebrana') : `Nie udało się: ${res.error}`, res.ok ? 'success' : 'error');
      await loadCards();
      await loadStatus();
    } catch (err) {
      notify(`Nie udało się odebrać karty: ${(err as Error).message}`, 'error');
    }
  });

  const retry = () => run('retry', async () => {
    try {
      const res = await api.akuvoxRetry();
      notify(`Ponowiono ${res.total}, udanych ${res.ok}`, res.ok === res.total ? 'success' : 'error');
      await loadCards();
      await loadStatus();
    } catch (err) {
      notify(`Ponowienie nie udało się: ${(err as Error).message}`, 'error');
    }
  });

  const openLog = () => run('log', async () => {
    setLog(await api.akuvoxLog());
    setShowLog(true);
  });

  const linked = cards.filter((c) => c.link.provider);
  const selectedCard = cards.find((c) => c.id === Number(cardId));
  const canAssign = Boolean(cardId !== '' && siteId && apartmentId && residentId && status?.configured);

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h2>Akuvox — chmura</h2>
          <p className="page__sub">
            Przypisywanie odczytanych kart mieszkańcom w chmurze Akuvox (akubela OpenAPI)
            {status?.unsynced ? ` · ${status.unsynced} kart czeka na wysłanie` : ''}
          </p>
        </div>
        <div className="page__actions">
          {status && status.unsynced > 0 && (
            <button className="btn btn--ghost" disabled={busy !== ''} onClick={retry}>
              Ponów zaległe ({status.unsynced})
            </button>
          )}
          <button className="btn btn--ghost" disabled={busy !== ''} onClick={openLog}>
            Dziennik zapytań
          </button>
          <button className="btn btn--primary" disabled={busy !== ''} onClick={runTest}>
            {busy === 'test' ? 'Sprawdzam…' : 'Sprawdź połączenie'}
          </button>
        </div>
      </header>

      <div className="settings">
        <div className="card">
          <h3 className="card__title">Połączenie</h3>
          <p className="card__lead">
            Poświadczenia do OpenAPI wydaje pomoc techniczna akubela
            (<code>support@akubela.com</code>); dokumentacja wymaga, by integrację
            uruchamiać najpierw na serwerze testowym. Dokumentacja:{' '}
            <a href={status?.docs} target="_blank" rel="noreferrer">developer.akubela.com</a>.
          </p>

          <div className="form-grid">
            <label className="span2">
              Serwer
              <select
                value={region}
                onChange={(e) => {
                  const found = status?.regions.find((r) => r.id === e.target.value);
                  setRegion(e.target.value);
                  if (found) setBaseUrl(found.baseUrl);
                }}
              >
                <option value="">— wybierz region —</option>
                {status?.regions.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              <small className="hint">Konto jest przypisane do regionu — wybór złego serwera daje błąd poświadczeń.</small>
            </label>
            <label className="span2">
              Adres API
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.ecloud.pre.akubela.com" spellCheck={false} />
            </label>
            <label>
              client_id
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label>
              client_secret
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={status?.hasClientSecret ? '•••••••• (zapisany)' : ''}
                autoComplete="new-password"
              />
            </label>
            <label>
              Login zarządcy
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label>
              Hasło zarządcy
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={status?.hasPassword ? '•••••••• (zapisane)' : ''}
                autoComplete="new-password"
              />
            </label>
            <label className="span2">
              Format numeru karty
              <select value={cardFormat} onChange={(e) => setCardFormat(e.target.value)}>
                {status?.cardFormats.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              <small className="hint">
                {status?.cardFormats.find((f) => f.id === cardFormat)?.hint}
                {' '}Dokumentacja nie precyzuje tej postaci — po pierwszym przypisaniu sprawdź numer w panelu Akuvox.
              </small>
            </label>
            <label className="checkbox span2">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              Tryb podglądu — pokazuj zapytania w dzienniku, nie wysyłaj ich
            </label>
          </div>

          {status && !status.secretStorageAvailable && (
            <p className="card__note">
              System nie udostępnia szyfrowanego magazynu haseł, więc sekretów nie da się zapisać
              trwale — trzeba je podawać po każdym uruchomieniu.
            </p>
          )}
          {status && !status.configured && status.missing.length > 0 && (
            <p className="card__note">Brakuje: {status.missing.join(', ')}.</p>
          )}

          <div className="card__actions">
            <button className="btn btn--primary" disabled={busy !== ''} onClick={save}>
              {busy === 'save' ? 'Zapisywanie…' : 'Zapisz połączenie'}
            </button>
          </div>

          {test && (
            <ul className="steps">
              {test.steps.map((s) => (
                <li key={s.step} className={s.ok ? 'steps__ok' : 'steps__bad'}>
                  <strong>{s.step}</strong> — {s.detail}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h3 className="card__title">Przypisz kartę</h3>
          <p className="card__lead">
            Kolejność jest wymuszona przez API: obiekt (<code>project</code>) → mieszkanie
            (<code>residence</code>) → mieszkaniec (<code>account</code>).
          </p>

          <div className="form-grid">
            <label className="span2">
              Karta z bazy
              <select value={cardId} onChange={(e) => setCardId(e.target.value === '' ? '' : Number(e.target.value))}>
                <option value="">— wybierz kartę —</option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {(c.label || 'bez nazwy')} · {c.uidHex}
                    {c.link.provider ? ` — przypisana: ${c.link.residentName || c.link.residentId}` : ''}
                  </option>
                ))}
              </select>
              {cards.length === 0 && <small className="hint">Baza kart jest pusta — zbliż kartę do czytnika w zakładce Skanowanie.</small>}
            </label>

            <label>
              Obiekt
              <select value={siteId} onChange={(e) => void pickSite(e.target.value)}>
                <option value="">— wybierz obiekt —</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="checkbox">
              <button className="btn btn--ghost btn--tiny" disabled={busy !== ''} onClick={loadSites}>
                {busy === 'sites' ? 'Wczytywanie…' : 'Wczytaj obiekty'}
              </button>
            </label>

            <label className="span2">
              Mieszkanie
              <select value={apartmentId} disabled={!siteId || busy === 'apartments'} onChange={(e) => void pickApartment(e.target.value)}>
                <option value="">{busy === 'apartments' ? 'wczytywanie…' : '— wybierz mieszkanie —'}</option>
                {apartments.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}{a.extra ? ` (${a.extra})` : ''}</option>
                ))}
              </select>
            </label>

            <label className="span2">
              Mieszkaniec
              <select value={residentId} disabled={!apartmentId || busy === 'residents'} onChange={(e) => setResidentId(e.target.value)}>
                <option value="">{busy === 'residents' ? 'wczytywanie…' : '— wybierz mieszkańca —'}</option>
                {residents.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          </div>

          {selectedCard && (
            <p className="card__note">
              Do chmury poleci numer: <code>{selectedCard.uidHex}</code> w postaci{' '}
              <strong>{status?.cardFormats.find((f) => f.id === cardFormat)?.id}</strong>.
            </p>
          )}

          <div className="card__actions">
            <button className="btn btn--primary" disabled={!canAssign || busy !== ''} onClick={assign}>
              {busy === 'assign' ? 'Przypisywanie…' : 'Przypisz kartę mieszkańcowi'}
            </button>
          </div>
        </div>

        <div className="card">
          <h3 className="card__title">Czego dokumentacja nie rozstrzyga</h3>
          <ul className="caveats">
            {status?.caveats.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </div>
      </div>

      {linked.length > 0 && (
        <>
          <h3 className="page__section">Karty powiązane z chmurą</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Karta</th>
                  <th>UID</th>
                  <th>Obiekt</th>
                  <th>Mieszkanie</th>
                  <th>Mieszkaniec</th>
                  <th>Stan</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {linked.map((c) => (
                  <tr key={c.id}>
                    <td className="strong">{c.label || <span className="muted">bez nazwy</span>}</td>
                    <td><code>{c.uidHex}</code></td>
                    <td className="small">{c.link.siteName || c.link.siteId}</td>
                    <td className="small">{c.link.apartmentName || c.link.apartmentId}</td>
                    <td className="small">{c.link.residentName || c.link.residentId}</td>
                    <td>
                      <span className={`badge badge--${c.link.state === 'synced' ? 'granted' : c.link.state === 'error' ? 'denied' : 'unknown'}`}>
                        {c.link.state === 'synced' ? 'w chmurze' : c.link.state === 'error' ? 'błąd' : c.link.state}
                      </span>
                      {c.link.error && <div className="small muted">{c.link.error}</div>}
                    </td>
                    <td className="right nowrap">
                      <button className="btn btn--tiny btn--danger" disabled={busy !== ''} onClick={() => unassign(c)}>
                        Odbierz
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {showLog && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setShowLog(false)}>
          <div className="modal__box modal__box--wide" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">Dziennik zapytań do chmury</h3>
            <p className="card__note">Sekrety są zamaskowane. Najnowsze zapytanie na górze.</p>
            {log.length === 0 && <p className="panel__empty">Brak zapytań.</p>}
            {log.map((entry, i) => (
              <details key={`${entry.at}-${i}`} className="logentry">
                <summary>
                  <code>{entry.method}</code> {entry.status ?? '—'}{' '}
                  {entry.dryRun && <span className="chip chip--warn">podgląd</span>}
                  {entry.error && <span className="chip chip--warn">błąd</span>}
                  <span className="muted"> · {entry.ms} ms · {formatDateTime(entry.at)}</span>
                </summary>
                <div className="logentry__body">
                  <div className="break small">{entry.url}</div>
                  {entry.error && <div className="small" style={{ color: 'var(--bad)' }}>{entry.error}</div>}
                  <pre>{JSON.stringify({ zapytanie: entry.body, odpowiedz: entry.response }, null, 2)}</pre>
                </div>
              </details>
            ))}
            <footer className="modal__actions">
              <button className="btn btn--ghost" onClick={() => setShowLog(false)}>Zamknij</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
