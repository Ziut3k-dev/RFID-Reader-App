import { useState } from 'react';
import { api } from '../api';
import type { Card, Uid } from '../types';

interface Props {
  uid: Uid;
  onEnrolled: (card: Card) => void;
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

/** Dopisanie świeżo odczytanej, nieznanej karty bez opuszczania panelu odczytu. */
export function EnrollForm({ uid, onEnrolled, notify }: Props) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [owner, setOwner] = useState('');
  const [role, setRole] = useState('user');
  const [validTo, setValidTo] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const card = await api.createCard({
        uidHex: uid.hex,
        label: label.trim(),
        owner: owner.trim(),
        role,
        validTo: validTo || null,
        active: true,
      });
      setOpen(false);
      setLabel('');
      setOwner('');
      setValidTo('');
      onEnrolled(card);
    } catch (err) {
      notify(`Nie udało się zapisać karty: ${(err as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button className="btn btn--primary enroll__open" onClick={() => setOpen(true)}>
        Dopisz tę kartę do bazy
      </button>
    );
  }

  return (
    <form className="enroll" onSubmit={submit}>
      <div className="enroll__grid">
        <label>
          Nazwa karty
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="np. Karta 12 / Magazyn"
            autoFocus
          />
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
        <label>
          Ważna do
          <input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </label>
      </div>
      <div className="enroll__actions">
        <code>{uid.pretty}</code>
        <div>
          <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
            Anuluj
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? 'Zapisywanie…' : 'Zapisz kartę'}
          </button>
        </div>
      </div>
    </form>
  );
}
