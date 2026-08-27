import { useCallback, useEffect, useState } from 'react';
import { api, isElectron } from './api';
import type { Settings, Stats } from './types';
import { ScanPanel } from './components/ScanPanel';
import { CardsPanel } from './components/CardsPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ToastStack, useToasts } from './components/Toasts';

type Tab = 'scan' | 'cards' | 'history' | 'settings';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'scan', label: 'Skanowanie', hint: 'Odczyt kart z czytnika' },
  { id: 'cards', label: 'Karty', hint: 'Baza kart i uprawnień' },
  { id: 'history', label: 'Historia', hint: 'Dziennik odczytów' },
  { id: 'settings', label: 'Ustawienia', hint: 'Czytnik i reguły' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('scan');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const { toasts, notify, dismiss } = useToasts();

  const refreshStats = useCallback(async () => {
    try {
      setStats(await api.stats());
    } catch (err) {
      notify(`Nie udało się odczytać statystyk: ${(err as Error).message}`, 'error');
    }
  }, [notify]);

  useEffect(() => {
    void (async () => {
      try {
        setSettings(await api.getSettings());
        await refreshStats();
      } catch (err) {
        notify(`Błąd wczytywania danych: ${(err as Error).message}`, 'error');
      }
    })();
  }, [notify, refreshStats]);

  const saveSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const next = await api.setSettings(patch);
      setSettings(next);
      return next;
    },
    [],
  );

  if (!settings) {
    return <div className="boot">Wczytywanie…</div>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <path d="M4 12a8 8 0 0 1 8-8" opacity=".35" />
              <path d="M7.5 12A4.5 4.5 0 0 1 12 7.5" />
              <path d="M11 12h1" />
              <path d="M12 16.5A4.5 4.5 0 0 0 16.5 12" />
              <path d="M12 20a8 8 0 0 0 8-8" opacity=".35" />
            </svg>
          </span>
          <div>
            <div className="brand__title">RFID Scanner</div>
            <div className="brand__sub">
              13,56 MHz · ISO14443A · S50/S70 · stanowisko <strong>{settings.station}</strong>
            </div>
          </div>
        </div>

        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? 'tab--active' : ''}`}
              onClick={() => setTab(t.id)}
              title={t.hint}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {!isElectron && (
          <span className="chip chip--warn" title="Dane trafiają do localStorage przeglądarki">
            tryb podglądu
          </span>
        )}
      </header>

      <main className="content">
        {tab === 'scan' && (
          <ScanPanel
            settings={settings}
            stats={stats}
            onStatsChange={refreshStats}
            notify={notify}
          />
        )}
        {tab === 'cards' && <CardsPanel notify={notify} onChange={refreshStats} />}
        {tab === 'history' && <HistoryPanel notify={notify} />}
        {tab === 'settings' && (
          <SettingsPanel settings={settings} onSave={saveSettings} notify={notify} />
        )}
      </main>

      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  );
}
