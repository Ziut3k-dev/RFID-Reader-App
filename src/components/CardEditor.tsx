import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Card } from '../types';

interface Props {
  card: Card | null;
  onClose: () => void;
  onSaved: (card: Card) => void;
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

/** Okno dodawania i edycji karty. Numer istniejącej karty jest niezmienny. */
export function CardEditor({ card, onClose, onSaved, notify }: Props) {
  const [uid, setUid] = useState(card?.uidHex ?? '');
  const [label, setLabel] = useState(card?.label ?? '');
  const [owner, setOwner] = useState(card?.owner ?? '');
  const [role, setRole] = useState(card?.role ?? 'user');
  const [active, setActive] = useState(card?.active ?? true);
  const [validFrom, setValidFrom] = useState(card?.validFrom ?? '');
  const [validTo, setValidTo] = useState(card?.validTo ?? '');
  const [note, setNote] = useState(card?.note ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        label: label.trim(),
        owner: owner.trim(),
        role,
        active,
        validFrom: validFrom || null,
        validTo: validTo || null,
        note: note.trim(),
      };
      const saved = card
        ? await api.updateCard(card.id, payload)
        : await api.createCard({ uid: uid.trim(), ...payload });
      notify(card ? 'Zmiany zapisane' : `Karta zapisana: ${saved.label || saved.uidHex}`, 'success');
      onSaved(saved);
    } catch (err) {
      notify(`Nie udało się zapisać: ${(err as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={onClose}>
      <form className="modal__box" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3 className="modal__title">{card ? 'Edycja karty' : 'Nowa karta'}</h3>

        <div className="form-grid">
          <label className="span2">
            Numer karty (UID)
            {card ? (
              <input value={uid} readOnly className="readonly" />
            ) : (
              <input
                value={uid}
                onChange={(e) => setUid(e.target.value)}
                placeholder="0004372425 · 0042B7C9 · 04:A2:2B:9C"
                autoFocus
                required
                spellCheck={false}
              />
            )}
            {!card && (
              <small className="hint">
                Numer jest interpretowany zgodnie z trybem z zakładki Ustawienia. Prościej jest
                zbliżyć kartę do czytnika w zakładce Skanowanie.
              </small>
            )}
          </label>

          <label>
            Nazwa
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="np. Karta 12" />
          </label>
          <label>
            Właściciel
            <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="np. Anna Kowalska" />
          </label>
          <label>
            Rola
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="user">użytkownik</option>
              <option value="admin">administrator</option>
              <option value="guest">gość</option>
              <option value="service">serwis</option>
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Karta aktywna
          </label>
          <label>
            Ważna od
            <input type="date" value={validFrom ?? ''} onChange={(e) => setValidFrom(e.target.value)} />
          </label>
          <label>
            Ważna do
            <input type="date" value={validTo ?? ''} onChange={(e) => setValidTo(e.target.value)} />
          </label>
          <label className="span2">
            Notatka
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </label>
        </div>

        <footer className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Anuluj
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? 'Zapisywanie…' : 'Zapisz'}
          </button>
        </footer>
      </form>
    </div>
  );
}
