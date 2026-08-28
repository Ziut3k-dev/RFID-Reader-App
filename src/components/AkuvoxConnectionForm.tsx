import { useState } from 'react';
import { api } from '../api';
import type { AkuvoxCardFormat, AkuvoxConnection, AkuvoxRegion, AkuvoxStatus } from '../types';

interface Props {
  connection: AkuvoxConnection | null;
  regions: AkuvoxRegion[];
  cardFormats: AkuvoxCardFormat[];
  onClose: () => void;
  onSaved: (status: AkuvoxStatus) => void;
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

/**
 * Dane jednego połączenia z chmurą. Osobne okno, bo instalator wypełnia je raz
 * na klienta i potem tylko przełącza się między nimi.
 */
export function ConnectionForm({ connection, regions, cardFormats, onClose, onSaved, notify }: Props) {
  const [name, setName] = useState(connection?.name ?? '');
  const [region, setRegion] = useState(connection?.region ?? '');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [clientId, setClientId] = useState(connection?.clientId ?? '');
  const [username, setUsername] = useState(connection?.username ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [password, setPassword] = useState('');
  const [cardFormat, setCardFormat] = useState(connection?.cardFormat ?? 'dec');
  const [dryRun, setDryRun] = useState(connection?.dryRun ?? false);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const status = await api.akuvoxSaveConnection({
        id: connection?.id,
        name: name.trim(),
        region,
        baseUrl: baseUrl.trim(),
        clientId: clientId.trim(),
        username: username.trim(),
        cardFormat,
        dryRun,
        // Puste pola sekretów zostawiają dotychczasowe wartości — inaczej każda
        // zmiana nazwy wymagałaby wpisywania hasła od nowa.
        ...(clientSecret ? { clientSecret } : {}),
        ...(password ? { password } : {}),
      });
      onSaved(status);
    } catch (err) {
      notify(`Nie udało się zapisać: ${(err as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={onClose}>
      <form className="modal__box" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3 className="modal__title">{connection ? 'Edycja połączenia' : 'Nowe połączenie'}</h3>

        <div className="form-grid">
          <label className="span2">
            Nazwa (dla Ciebie)
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="np. Kwiatowa 3 — wspólnota" required autoFocus />
          </label>

          <label className="span2">
            Serwer
            <select
              value={region}
              onChange={(e) => {
                setRegion(e.target.value);
                const found = regions.find((r) => r.id === e.target.value);
                if (found) setBaseUrl(found.baseUrl);
              }}
            >
              <option value="">— wybierz region —</option>
              {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <small className="hint">Konto należy do jednego regionu — zły serwer daje błąd poświadczeń.</small>
          </label>

          <label className="span2">
            Adres API
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.ecloud.pre.akubela.com" spellCheck={false} required />
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
              placeholder={connection?.hasClientSecret ? '•••••••• (zapisany)' : ''}
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
              placeholder={connection?.hasPassword ? '•••••••• (zapisane)' : ''}
              autoComplete="new-password"
            />
          </label>

          <label className="span2">
            Format numeru karty
            <select value={cardFormat} onChange={(e) => setCardFormat(e.target.value)}>
              {cardFormats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <small className="hint">
              {cardFormats.find((f) => f.id === cardFormat)?.hint}{' '}
              Dokumentacja nie precyzuje tej postaci — po pierwszym wydaniu sprawdź numer w panelu Akuvox.
            </small>
          </label>

          <label className="checkbox span2">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            Tryb podglądu — pokazuj zapytania w dzienniku, nie wysyłaj ich
          </label>
        </div>

        <footer className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Anuluj</button>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? 'Zapisywanie…' : 'Zapisz'}
          </button>
        </footer>
      </form>
    </div>
  );
}
