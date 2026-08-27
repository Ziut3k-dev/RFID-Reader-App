import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Card } from '../types';
import { CardEditor } from './CardEditor';

interface Props {
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void;
  onChange: () => void;
}

export function CardsPanel({ notify, onChange }: Props) {
  const [cards, setCards] = useState<Card[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Card | 'new' | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCards(await api.listCards({ q: query }));
    } catch (err) {
      notify(`Nie udało się wczytać kart: ${(err as Error).message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [notify, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleActive = async (card: Card) => {
    try {
      await api.updateCard(card.id, { active: !card.active });
      await load();
      onChange();
    } catch (err) {
      notify(`Nie udało się zmienić statusu: ${(err as Error).message}`, 'error');
    }
  };

  const remove = async (card: Card) => {
    const name = card.label || card.uidHex;
    if (!window.confirm(`Usunąć kartę „${name}”?\n\nHistoria odczytów zostanie zachowana, ale straci powiązanie z kartą.`)) {
      return;
    }
    try {
      await api.deleteCard(card.id);
      notify(`Karta „${name}” usunięta`, 'success');
      await load();
      onChange();
    } catch (err) {
      notify(`Nie udało się usunąć karty: ${(err as Error).message}`, 'error');
    }
  };

  const exportCsv = async () => {
    try {
      const res = await api.exportCsv('cards');
      if (res.canceled) return;
      notify(res.filePath ? `Zapisano ${res.filePath}` : 'Plik CSV pobrany', 'success');
    } catch (err) {
      notify(`Eksport nie powiódł się: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h2>Karty</h2>
          <p className="page__sub">
            {cards.length} {cards.length === 1 ? 'karta' : 'kart'} w bazie
            {query && ' (wynik filtrowania)'}
          </p>
        </div>
        <div className="page__actions">
          <input
            className="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Szukaj: nazwa, właściciel, UID…"
            spellCheck={false}
          />
          <button className="btn btn--ghost" onClick={() => void exportCsv()}>
            Eksport CSV
          </button>
          <button className="btn btn--primary" onClick={() => setEditing('new')}>
            Nowa karta
          </button>
        </div>
      </header>

      {loading && <p className="panel__empty">Wczytywanie…</p>}

      {!loading && cards.length === 0 && (
        <div className="empty">
          <h3>Brak kart</h3>
          <p>
            Przejdź do zakładki <strong>Skanowanie</strong>, zbliż kartę do czytnika i użyj przycisku
            „Dopisz tę kartę do bazy” — numer wypełni się automatycznie.
          </p>
        </div>
      )}

      {!loading && cards.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nazwa</th>
                <th>Właściciel</th>
                <th>UID</th>
                <th>Rola</th>
                <th>Ważność</th>
                <th className="num">Odczyty</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={card.id} className={card.active ? '' : 'row--off'}>
                  <td className="strong">{card.label || <span className="muted">bez nazwy</span>}</td>
                  <td>{card.owner || <span className="muted">—</span>}</td>
                  <td>
                    <code title={`dziesiętnie: ${card.uidDec}`}>{card.uidHex}</code>
                  </td>
                  <td>
                    <span className="chip">{card.role}</span>
                  </td>
                  <td className="small">
                    {card.validFrom || card.validTo
                      ? `${card.validFrom || '…'} → ${card.validTo || '…'}`
                      : <span className="muted">bez limitu</span>}
                  </td>
                  <td className="num">{card.scanCount ?? 0}</td>
                  <td>
                    <button
                      className={`toggle ${card.active ? 'toggle--on' : ''}`}
                      onClick={() => void toggleActive(card)}
                      title={card.active ? 'Zablokuj kartę' : 'Odblokuj kartę'}
                    >
                      <span />
                      {card.active ? 'aktywna' : 'zablokowana'}
                    </button>
                  </td>
                  <td className="right nowrap">
                    <button className="btn btn--tiny" onClick={() => setEditing(card)}>
                      Edytuj
                    </button>
                    <button className="btn btn--tiny btn--danger" onClick={() => void remove(card)}>
                      Usuń
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <CardEditor
          card={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
            onChange();
          }}
          notify={notify}
        />
      )}
    </div>
  );
}
