import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useKeyboardWedge } from '../hooks/useKeyboardWedge';
import { playFeedback } from '../lib/sound';
import { formatDateTime, formatTime } from '../lib/format';
import type {
  AkuvoxConnection, AkuvoxStatus, AkuvoxTarget, AkuvoxTestResult, AssignWarning,
  Card, RemoteItem, RequestLogEntry,
} from '../types';
import { ConnectionForm } from './AkuvoxConnectionForm';

interface Props {
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

/** Cel wydania karty: mieszkaniec razem z mieszkaniem, w którym mieszka. */
interface Target {
  resident: RemoteItem;
  apartment: RemoteItem | null;
}

type Mode = 'single' | 'series';

/**
 * Integracja z chmurą Akuvox z punktu widzenia instalatora.
 *
 * Dwa tryby pracy, bo to dwie różne sytuacje: pojedyncze wydanie karty
 * (nowy najemca) i uruchomienie obiektu, gdzie kart jest dwieście i liczy się
 * każde kliknięcie mniej.
 */
export function AkuvoxPanel({ notify }: Props) {
  const [status, setStatus] = useState<AkuvoxStatus | null>(null);
  const [mode, setMode] = useState<Mode>('single');
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState<AkuvoxTestResult | null>(null);
  const [editing, setEditing] = useState<AkuvoxConnection | 'new' | null>(null);

  const [sites, setSites] = useState<RemoteItem[]>([]);
  const [apartments, setApartments] = useState<RemoteItem[]>([]);
  const [residents, setResidents] = useState<RemoteItem[]>([]);
  const [siteId, setSiteId] = useState('');
  const [apartmentId, setApartmentId] = useState('');
  const [residentId, setResidentId] = useState('');

  const [cards, setCards] = useState<Card[]>([]);
  const [cardId, setCardId] = useState<number | ''>('');
  const [warnings, setWarnings] = useState<AssignWarning[]>([]);

  // tryb seryjny
  const [targets, setTargets] = useState<Target[]>([]);
  const [cursor, setCursor] = useState(0);
  const [armed, setArmed] = useState(false);
  const [seriesLog, setSeriesLog] = useState<{ at: string; text: string; ok: boolean }[]>([]);

  const [replaceFor, setReplaceFor] = useState<Card | null>(null);
  const [log, setLog] = useState<RequestLogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);

  const active = status?.active ?? null;
  const cardFormats = status?.cardFormats ?? [];

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.akuvoxStatus());
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

  // Automatyczne dosyłanie zaległych zgłasza się samo — instalator ma wiedzieć,
  // że kolejka zeszła, bez odświeżania widoku.
  useEffect(() => api.onAkuvoxSync((report) => {
    if (report.total > 0) {
      notify(`Dosłano zaległe: ${report.ok} z ${report.total}`, report.ok === report.total ? 'success' : 'error');
      void loadStatus();
      void loadCards();
    }
  }), [loadCards, loadStatus, notify]);

  const run = async <T,>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    try {
      return await action();
    } catch (err) {
      notify((err as Error).message, 'error');
      return undefined;
    } finally {
      setBusy('');
    }
  };

  // --- połączenia ------------------------------------------------------------

  const activate = (id: string) => run('activate', async () => {
    setStatus(await api.akuvoxActivateConnection(id));
    setSites([]); setApartments([]); setResidents([]); setTargets([]);
    setSiteId(''); setApartmentId(''); setResidentId('');
  });

  const removeConnection = (conn: AkuvoxConnection) => run('delete', async () => {
    if (!window.confirm(
      `Usunąć połączenie „${conn.name}”?\n\n`
      + `${conn.linkedCards} kart straci powiązanie z chmurą (same karty i historia odczytów zostaną).`,
    )) return;
    const res = await api.akuvoxDeleteConnection(conn.id);
    setStatus(res.status);
    notify(`Połączenie usunięte, kart odwiązanych: ${res.unlinkedCards}`, 'success');
    await loadCards();
  });

  const saveOptions = (patch: { installerName?: string; offlineQueue?: boolean; autoSync?: boolean }) =>
    run('options', async () => setStatus(await api.akuvoxSaveOptions(patch)));

  // --- listy z chmury --------------------------------------------------------

  const loadSites = () => run('sites', async () => {
    const list = await api.akuvoxSites();
    setSites(list);
    if (list.length === 0) notify('Konto nie widzi żadnego obiektu', 'info');
  });

  const pickSite = async (id: string) => {
    setSiteId(id);
    setApartmentId(''); setResidentId('');
    setApartments([]); setResidents([]); setTargets([]); setCursor(0);
    if (!id) return;
    await run('site', async () => {
      // Pobieramy oba wykazy naraz: tryb seryjny potrzebuje mieszkańców
      // z przypisanymi mieszkaniami, a API nie łączy ich za nas.
      const [apartmentList, residentList] = await Promise.all([
        api.akuvoxApartments(id),
        api.akuvoxResidents(id),
      ]);
      setApartments(apartmentList);
      setResidents(residentList);
      setTargets(residentList.map((resident) => ({
        resident,
        apartment: apartmentList.find((a) => a.id === String(resident.extra ?? '')) ?? null,
      })));
    });
  };

  const apartmentLabel = (a: RemoteItem | null) => (a ? `${a.name}${a.extra ? ` (${a.extra})` : ''}` : '—');

  const targetFor = (t: Target): AkuvoxTarget => ({
    siteId,
    siteName: sites.find((s) => s.id === siteId)?.name,
    apartmentId: t.apartment?.id ?? '',
    apartmentName: apartmentLabel(t.apartment),
    residentId: t.resident.id,
    residentName: t.resident.name,
  });

  // --- pojedyncze przypisanie ------------------------------------------------

  const singleTarget = (): AkuvoxTarget => ({
    siteId,
    siteName: sites.find((s) => s.id === siteId)?.name,
    apartmentId,
    apartmentName: apartmentLabel(apartments.find((a) => a.id === apartmentId) ?? null),
    residentId,
    residentName: residents.find((r) => r.id === residentId)?.name,
  });

  useEffect(() => {
    // Ostrzeżenia liczymy przy zmianie wyboru, żeby instalator zobaczył je
    // przed kliknięciem, nie po.
    if (cardId === '' || !siteId || !apartmentId || !residentId) {
      setWarnings([]);
      return;
    }
    let cancelled = false;
    void api.akuvoxCheck(Number(cardId), singleTarget())
      .then((w) => { if (!cancelled) setWarnings(w); })
      .catch(() => { if (!cancelled) setWarnings([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, siteId, apartmentId, residentId]);

  const assignSingle = () => run('assign', async () => {
    const result = await api.akuvoxAssign(Number(cardId), singleTarget());
    describeAssign(result, cards.find((c) => c.id === Number(cardId))?.label || '');
    await loadCards();
    await loadStatus();
  });

  const describeAssign = (
    result: { ok: boolean; queued?: boolean; cardNumber?: string; verified?: boolean; error?: string },
    label: string,
  ) => {
    if (!result.ok) {
      notify(`${label}: chmura odmówiła — ${result.error}`, 'error');
      return false;
    }
    if (result.queued) {
      notify(`${label}: odłożone w kolejce (tryb offline)`, 'info');
      return true;
    }
    if (result.verified === false) {
      notify(`${label}: zapisano numer ${result.cardNumber}, ale nie potwierdzono odczytem`, 'error');
      return true;
    }
    notify(`${label}: przypisano numer ${result.cardNumber}, potwierdzone`, 'success');
    return true;
  };

  // --- tryb seryjny ----------------------------------------------------------

  const current = targets[cursor] ?? null;
  const currentRef = useRef<Target | null>(null);
  currentRef.current = current;

  const handleSeriesScan = useCallback(async (raw: string) => {
    const target = currentRef.current;
    if (!target) return;
    setBusy('series');
    try {
      // Odczyt przechodzi normalną ścieżką: karta nieznana zostaje dopisana,
      // żeby instalator nie musiał jej wcześniej rejestrować.
      const scan = await api.scan(raw);
      if (!scan.ok || !scan.uid) {
        setSeriesLog((l) => [{ at: new Date().toISOString(), text: `Nie rozpoznano odczytu: ${scan.error}`, ok: false }, ...l]);
        playFeedback('denied');
        return;
      }
      let card = scan.card ?? null;
      if (!card) {
        card = await api.createCard({
          uidHex: scan.uid.hex,
          label: `${apartmentLabel(target.apartment)} — ${target.resident.name}`,
          owner: target.resident.name,
        });
      }
      const result = await api.akuvoxAssign(card.id, targetFor(target));
      const ok = describeAssign(result, target.resident.name);
      playFeedback(ok ? 'granted' : 'denied');
      setSeriesLog((l) => [{
        at: new Date().toISOString(),
        text: `${target.resident.name} · ${apartmentLabel(target.apartment)} · ${scan.uid!.hex}`
          + (result.queued ? ' — w kolejce' : ''),
        ok,
      }, ...l].slice(0, 40));
      if (ok) setCursor((c) => Math.min(c + 1, targets.length));
      await loadCards();
      await loadStatus();
    } finally {
      setBusy('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.length, siteId, sites, loadCards, loadStatus]);

  useKeyboardWedge({
    enabled: armed && mode === 'series' && Boolean(current),
    onScan: (raw) => void handleSeriesScan(raw),
  });

  // --- karty powiązane ------------------------------------------------------

  const verify = (card: Card) => run(`verify-${card.id}`, async () => {
    const res = await api.akuvoxVerify(card.id);
    notify(
      res.verified ? `Karta potwierdzona w chmurze (${res.number})` : `Nie potwierdzono: ${res.error || 'karty nie widać u mieszkańca'}`,
      res.verified ? 'success' : 'error',
    );
    await loadCards();
  });

  const unassign = (card: Card) => run(`unassign-${card.id}`, async () => {
    if (!window.confirm(`Odebrać kartę „${card.label || card.uidHex}” mieszkańcowi ${card.link.residentName}?`)) return;
    const res = await api.akuvoxUnassign(card.id);
    notify(res.ok ? (res.message || 'Karta odebrana') : `Nie udało się: ${res.error}`, res.ok ? 'success' : 'error');
    await loadCards();
    await loadStatus();
  });

  const retry = () => run('retry', async () => {
    const res = await api.akuvoxRetry();
    notify(`Ponowiono ${res.total}, udanych ${res.ok}`, res.ok === res.total ? 'success' : 'error');
    await loadCards();
    await loadStatus();
  });

  const handover = (kind: 'csv' | 'pdf') => run(`handover-${kind}`, async () => {
    const res = await api.akuvoxHandover(kind, siteId || undefined);
    if (res.empty) notify('Nie ma czego zestawiać — żadna karta nie jest przypisana', 'info');
    else if (res.filePath) notify(`Zapisano ${res.rows} pozycji: ${res.filePath}`, 'success');
  });

  const openLog = () => run('log', async () => {
    setLog(await api.akuvoxLog());
    setShowLog(true);
  });

  const linked = cards.filter((c) => c.link.provider);
  const canAssign = Boolean(cardId !== '' && siteId && apartmentId && residentId && active?.configured);

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h2>Akuvox — chmura</h2>
          <p className="page__sub">
            {active ? `${active.name} · ${active.baseUrl}` : 'Brak połączenia — dodaj je niżej'}
            {status?.unsynced ? ` · ${status.unsynced} w kolejce` : ''}
            {status?.offlineQueue ? ' · tryb offline' : ''}
          </p>
        </div>
        <div className="page__actions">
          {status && status.unsynced > 0 && !status.offlineQueue && (
            <button className="btn btn--ghost" disabled={busy !== ''} onClick={retry}>
              Wyślij kolejkę ({status.unsynced})
            </button>
          )}
          <button className="btn btn--ghost" disabled={busy !== ''} onClick={() => handover('csv')}>Protokół CSV</button>
          <button className="btn btn--ghost" disabled={busy !== ''} onClick={() => handover('pdf')}>Protokół PDF</button>
          <button className="btn btn--ghost" disabled={busy !== ''} onClick={openLog}>Dziennik</button>
          <button className="btn btn--primary" disabled={busy !== '' || !active?.configured} onClick={() => run('test', async () => {
            const result = await api.akuvoxTest();
            setTest(result);
            if (result.ok) { setSites(result.sites ?? []); notify('Połączenie działa', 'success'); }
            else notify(result.steps.find((s) => !s.ok)?.detail || 'Połączenie nie działa', 'error');
          })}>
            {busy === 'test' ? 'Sprawdzam…' : 'Sprawdź połączenie'}
          </button>
        </div>
      </header>

      {/* --- połączenia klientów --- */}
      <div className="card">
        <h3 className="card__title">Połączenia</h3>
        <p className="card__lead">
          Każdy klient ma własne poświadczenia — wybierz, na którym obiekcie pracujesz.
          Poświadczenia do OpenAPI wydaje <code>support@akubela.com</code>; dokumentacja wymaga
          pracy najpierw na serwerze testowym. <a href={status?.docs} target="_blank" rel="noreferrer">developer.akubela.com</a>
        </p>

        {status?.connections.length === 0 && <p className="panel__empty">Brak połączeń.</p>}

        {status && status.connections.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th /><th>Nazwa</th><th>Serwer</th><th>Format numeru</th><th className="num">Karty</th><th>Stan</th><th /></tr>
              </thead>
              <tbody>
                {status.connections.map((c) => (
                  <tr key={c.id} className={c.id === status.activeId ? 'row--active' : ''}>
                    <td>
                      <input
                        type="radio"
                        checked={c.id === status.activeId}
                        onChange={() => void activate(c.id)}
                        aria-label={`Pracuj na ${c.name}`}
                      />
                    </td>
                    <td className="strong">{c.name}{c.dryRun && <span className="chip chip--warn">podgląd</span>}</td>
                    <td className="small break">{c.baseUrl}</td>
                    <td className="small">{c.cardFormat}</td>
                    <td className="num">{c.linkedCards}</td>
                    <td className="small">
                      {c.configured
                        ? <span className="badge badge--granted">gotowe</span>
                        : <span className="badge badge--unknown">brakuje: {c.missing.join(', ')}</span>}
                    </td>
                    <td className="right nowrap">
                      <button className="btn btn--tiny" onClick={() => setEditing(c)}>Edytuj</button>
                      <button className="btn btn--tiny btn--danger" onClick={() => void removeConnection(c)}>Usuń</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="card__actions">
          <button className="btn btn--primary" onClick={() => setEditing('new')}>Dodaj połączenie</button>
        </div>

        {status && !status.secretStorageAvailable && (
          <p className="card__note">
            System nie udostępnia szyfrowanego magazynu haseł — sekretów nie da się zapisać trwale.
          </p>
        )}

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

      {/* --- opcje instalatora --- */}
      <div className="card">
        <h3 className="card__title">Praca na obiekcie</h3>
        <div className="form-grid">
          <label>
            Kto wydaje karty
            <input
              value={status?.installerName ?? ''}
              onChange={(e) => setStatus((s) => (s ? { ...s, installerName: e.target.value } : s))}
              onBlur={(e) => void saveOptions({ installerName: e.target.value })}
              placeholder="imię i nazwisko — trafi do protokołu"
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={status?.offlineQueue ?? false}
              onChange={(e) => void saveOptions({ offlineQueue: e.target.checked })}
            />
            Tryb offline — zbieraj przypisania, nie wysyłaj
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={status?.autoSync ?? false}
              onChange={(e) => void saveOptions({ autoSync: e.target.checked })}
            />
            Dosyłaj zaległe automatycznie, gdy wróci łączność
          </label>
          {status?.lastSync && (
            <div className="small muted">
              Ostatnie dosyłanie: {formatDateTime(status.lastSync.at)} — {status.lastSync.ok} z {status.lastSync.total}
              {status.lastSync.error ? ` (${status.lastSync.error})` : ''}
            </div>
          )}
        </div>
      </div>

      {/* --- wybór obiektu --- */}
      <div className="card">
        <h3 className="card__title">Obiekt</h3>
        <div className="form-grid">
          <label>
            Obiekt (project)
            <select value={siteId} onChange={(e) => void pickSite(e.target.value)} disabled={busy === 'site'}>
              <option value="">— wybierz —</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="checkbox">
            <button className="btn btn--ghost btn--tiny" disabled={busy !== '' || !active?.configured} onClick={loadSites}>
              {busy === 'sites' ? 'Wczytywanie…' : 'Wczytaj obiekty'}
            </button>
          </label>
          {siteId && (
            <div className="small muted span2">
              Mieszkań: {apartments.length} · mieszkańców: {residents.length}
            </div>
          )}
        </div>

        <div className="modeswitch">
          <button className={`tab ${mode === 'single' ? 'tab--active' : ''}`} onClick={() => setMode('single')}>
            Pojedyncze wydanie
          </button>
          <button className={`tab ${mode === 'series' ? 'tab--active' : ''}`} onClick={() => setMode('series')}>
            Tryb seryjny
          </button>
        </div>
      </div>

      {mode === 'single' && (
        <div className="card">
          <h3 className="card__title">Przypisz kartę</h3>
          <div className="form-grid">
            <label className="span2">
              Karta z bazy
              <select value={cardId} onChange={(e) => setCardId(e.target.value === '' ? '' : Number(e.target.value))}>
                <option value="">— wybierz kartę —</option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {(c.label || 'bez nazwy')} · {c.uidHex}
                    {c.link.provider ? ` — ${c.link.residentName || c.link.residentId}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mieszkanie (residence)
              <select value={apartmentId} disabled={!siteId} onChange={(e) => { setApartmentId(e.target.value); setResidentId(''); }}>
                <option value="">— wybierz —</option>
                {apartments.map((a) => <option key={a.id} value={a.id}>{apartmentLabel(a)}</option>)}
              </select>
            </label>
            <label>
              Mieszkaniec (account)
              <select value={residentId} disabled={!apartmentId} onChange={(e) => setResidentId(e.target.value)}>
                <option value="">— wybierz —</option>
                {residents
                  .filter((r) => !apartmentId || String(r.extra ?? '') === apartmentId)
                  .map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          </div>

          {warnings.length > 0 && (
            <ul className="warnings">
              {warnings.map((w) => <li key={w.code}>{w.text}</li>)}
            </ul>
          )}

          <div className="card__actions">
            <button className="btn btn--primary" disabled={!canAssign || busy !== ''} onClick={assignSingle}>
              {busy === 'assign' ? 'Przypisywanie…' : status?.offlineQueue ? 'Dodaj do kolejki' : 'Przypisz kartę'}
            </button>
          </div>
        </div>
      )}

      {mode === 'series' && (
        <div className="card">
          <h3 className="card__title">Tryb seryjny</h3>
          <p className="card__lead">
            Zbliżaj karty po kolei — każda trafia do zaznaczonego mieszkańca, a lista przechodzi
            do następnego. Karta nieznana zostaje dopisana do bazy automatycznie.
          </p>

          {targets.length === 0 && <p className="panel__empty">Wybierz obiekt, żeby wczytać listę mieszkańców.</p>}

          {targets.length > 0 && (
            <>
              <div className="series__head">
                <button
                  className={`listen ${armed ? 'listen--on' : 'listen--off'}`}
                  onClick={() => setArmed((v) => !v)}
                >
                  <span className="listen__dot" />
                  {armed ? 'Czekam na kartę' : 'Nasłuch wyłączony'}
                </button>
                <span className="small muted">
                  {Math.min(cursor, targets.length)} z {targets.length}
                  {busy === 'series' && ' · przetwarzanie…'}
                </span>
                <div>
                  <button className="btn btn--tiny" disabled={cursor === 0} onClick={() => setCursor((c) => c - 1)}>Wstecz</button>
                  <button className="btn btn--tiny" disabled={cursor >= targets.length} onClick={() => setCursor((c) => c + 1)}>Pomiń</button>
                </div>
              </div>

              {current ? (
                <div className="series__current">
                  <div className="series__label">Teraz wydajesz kartę</div>
                  <div className="series__name">{current.resident.name}</div>
                  <div className="series__apartment">{apartmentLabel(current.apartment)}</div>
                  {!current.apartment && (
                    <div className="small" style={{ color: 'var(--warn)' }}>
                      Ten mieszkaniec nie ma powiązanego mieszkania w chmurze — przypisanie się nie uda.
                    </div>
                  )}
                </div>
              ) : (
                <div className="series__current">
                  <div className="series__name">Lista przeszła do końca</div>
                  <button className="btn btn--ghost btn--tiny" onClick={() => setCursor(0)}>Zacznij od początku</button>
                </div>
              )}

              <ol className="queue">
                {targets.slice(Math.max(0, cursor - 1), cursor + 5).map((t, i) => {
                  const index = Math.max(0, cursor - 1) + i;
                  return (
                    <li key={t.resident.id} className={index === cursor ? 'queue__now' : index < cursor ? 'queue__done' : ''}>
                      <button className="queue__pick" onClick={() => setCursor(index)}>
                        {t.resident.name} <span className="muted">· {apartmentLabel(t.apartment)}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>

              {seriesLog.length > 0 && (
                <ul className="feed">
                  {seriesLog.slice(0, 8).map((entry, i) => (
                    <li key={`${entry.at}-${i}`} className={`feed__item feed__item--${entry.ok ? 'granted' : 'denied'}`}>
                      <span className="feed__time">{formatTime(entry.at)}</span>
                      <span className="feed__who">{entry.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {/* --- zastrzeżenia --- */}
      <div className="card">
        <h3 className="card__title">Czego dokumentacja nie rozstrzyga</h3>
        <ul className="caveats">{status?.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
      </div>

      {linked.length > 0 && (
        <>
          <h3 className="page__section">Wydane karty ({linked.length})</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Karta</th><th>UID</th><th>Mieszkanie</th><th>Mieszkaniec</th>
                  <th>Wydał</th><th>Stan</th><th />
                </tr>
              </thead>
              <tbody>
                {linked.map((c) => (
                  <tr key={c.id}>
                    <td className="strong">
                      {c.label || <span className="muted">bez nazwy</span>}
                      {c.link.replacesCardId ? <span className="chip">wymiana</span> : null}
                    </td>
                    <td><code>{c.uidHex}</code></td>
                    <td className="small">{c.link.apartmentName || c.link.apartmentId}</td>
                    <td className="small">{c.link.residentName || c.link.residentId}</td>
                    <td className="small">{c.link.assignedBy || <span className="muted">—</span>}</td>
                    <td>
                      <span className={`badge badge--${c.link.state === 'synced' ? (c.link.verified ? 'granted' : 'unknown') : c.link.state === 'error' ? 'denied' : 'unknown'}`}>
                        {c.link.state === 'synced'
                          ? (c.link.verified ? 'potwierdzona' : 'niepotwierdzona')
                          : c.link.state === 'pending' ? 'w kolejce' : c.link.state === 'error' ? 'błąd' : c.link.state}
                      </span>
                      {c.link.error && <div className="small muted">{c.link.error}</div>}
                    </td>
                    <td className="right nowrap">
                      <button className="btn btn--tiny" disabled={busy !== ''} onClick={() => void verify(c)}>Sprawdź</button>
                      <button className="btn btn--tiny" disabled={busy !== ''} onClick={() => setReplaceFor(c)}>Wymień</button>
                      <button className="btn btn--tiny btn--danger" disabled={busy !== ''} onClick={() => void unassign(c)}>Odbierz</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && status && (
        <ConnectionForm
          connection={editing === 'new' ? null : editing}
          regions={status.regions}
          cardFormats={cardFormats}
          onClose={() => setEditing(null)}
          onSaved={(next) => { setStatus(next); setEditing(null); notify('Połączenie zapisane', 'success'); }}
          notify={notify}
        />
      )}

      {replaceFor && (
        <ReplaceDialog
          card={replaceFor}
          cards={cards}
          onClose={() => setReplaceFor(null)}
          onDone={async () => {
            setReplaceFor(null);
            await loadCards();
            await loadStatus();
          }}
          notify={notify}
        />
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
                  <code>{entry.method}</code> {entry.status ?? '—'}
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

/** Wymiana zgubionej karty — jedno okno, jedno działanie. */
function ReplaceDialog({ card, cards, onClose, onDone, notify }: {
  card: Card;
  cards: Card[];
  onClose: () => void;
  onDone: () => Promise<void>;
  notify: Props['notify'];
}) {
  const [newCardId, setNewCardId] = useState<number | ''>('');
  const [reason, setReason] = useState('zgubiona');
  const [saving, setSaving] = useState(false);

  // Karta zastępcza musi być wolna — inaczej odebralibyśmy ją komuś innemu.
  const available = cards.filter((c) => c.id !== card.id && !c.link.provider);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newCardId === '') return;
    setSaving(true);
    try {
      const res = await api.akuvoxReplace(card.id, Number(newCardId), reason);
      if (res.ok) notify('Karta wymieniona: stara zablokowana, nowa wydana', 'success');
      else notify(`Wymiana zatrzymała się na etapie „${res.stage}”: ${res.error || res.assignment?.error}`, 'error');
      await onDone();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={onClose}>
      <form className="modal__box" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3 className="modal__title">Wymiana karty</h3>
        <p className="card__lead">
          Stara karta zostanie odebrana w chmurze i zablokowana lokalnie (żeby znaleziona przez
          kogoś obcego dawała odmowę, a nie brak wpisu). Nowa trafi do tego samego mieszkańca:
          <strong> {card.link.residentName}</strong>, {card.link.apartmentName}.
        </p>
        <div className="form-grid">
          <label className="span2">
            Nowa karta
            <select value={newCardId} onChange={(e) => setNewCardId(e.target.value === '' ? '' : Number(e.target.value))} required>
              <option value="">— wybierz wolną kartę —</option>
              {available.map((c) => <option key={c.id} value={c.id}>{(c.label || 'bez nazwy')} · {c.uidHex}</option>)}
            </select>
            {available.length === 0 && (
              <small className="hint">Brak wolnych kart — zbliż nową kartę w zakładce Skanowanie i dopisz ją do bazy.</small>
            )}
          </label>
          <label className="span2">
            Powód
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="zgubiona / uszkodzona / zwrot" />
          </label>
        </div>
        <footer className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Anuluj</button>
          <button type="submit" className="btn btn--primary" disabled={saving || newCardId === ''}>
            {saving ? 'Wymieniam…' : 'Wymień kartę'}
          </button>
        </footer>
      </form>
    </div>
  );
}
