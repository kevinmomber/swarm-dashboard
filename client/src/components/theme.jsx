import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

const KEY = 'swarmdash.theme';

// mode: Helligkeitsfamilie, wird vom Schnellumschalter in der Seitenleiste genutzt.
export const THEMES = [
  { id: 'system', label: 'System', icon: '◐', mode: 'auto', desc: 'Folgt der Geräteeinstellung (hell/dunkel)', colors: ['#0d1117', '#f4f6fa', '#2f81f7'] },
  { id: 'dark', label: 'Dark', icon: '☾', mode: 'dark', desc: 'Klassisches dunkles Design', colors: ['#0d1117', '#161b22', '#2f81f7'] },
  { id: 'light', label: 'Light', icon: '☀', mode: 'light', desc: 'Helles Standarddesign', colors: ['#f4f6fa', '#ffffff', '#2f6fed'] },
  { id: 'glass', label: 'Glass', icon: '◇', mode: 'light', desc: 'Milchglas mit Unschärfe, hell (Liquid-Glass-Stil)', colors: ['#ffa0c8', '#78beff', '#0a84ff'] },
  { id: 'glass-dark', label: 'Glass Dark', icon: '◆', mode: 'dark', desc: 'Dunkles Glas auf farbigem Verlauf', colors: ['#a02878', '#145ac8', '#0a84ff'] },
  { id: 'midnight', label: 'Midnight', icon: '●', mode: 'dark', desc: 'Tiefschwarz (OLED-freundlich)', colors: ['#000000', '#15151d', '#3b82f6'] },
  { id: 'nord', label: 'Nord', icon: '❄', mode: 'dark', desc: 'Gedämpfte Polarfarben', colors: ['#2e3440', '#434c5e', '#5e81ac'] },
];
const IDS = THEMES.map((t) => t.id);
const norm = (t) => (IDS.includes(t) ? t : 'dark');

const ThemeCtx = createContext({ theme: 'dark', resolved: 'dark', setTheme: () => {}, toggle: () => {} });
export const useTheme = () => useContext(ThemeCtx);

const systemDark = () => !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
export const resolveTheme = (t) => (t === 'system' ? (systemDark() ? 'dark' : 'light') : norm(t));

export function applyTheme(theme) {
  document.documentElement.dataset.theme = resolveTheme(theme);
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => norm(localStorage.getItem(KEY) || 'dark'));
  const [resolved, setResolved] = useState(() => resolveTheme(theme));

  useEffect(() => {
    applyTheme(theme);
    setResolved(resolveTheme(theme));
    if (theme !== 'system' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => { applyTheme('system'); setResolved(resolveTheme('system')); };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);

  // Reconcile with server-stored preference once on mount.
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s?.theme && s.theme !== localStorage.getItem(KEY)) {
          localStorage.setItem(KEY, norm(s.theme));
          setThemeState(norm(s.theme));
        }
      })
      .catch(() => {});
  }, []);

  const setTheme = useCallback((t) => {
    localStorage.setItem(KEY, norm(t));
    setThemeState(norm(t));
  }, []);

  // Schnellumschalter: wechselt innerhalb der Familie (Glass <-> Glass Dark), sonst Dark <-> Light.
  const toggle = useCallback(() => {
    const dark = resolved !== 'light' && resolved !== 'glass';
    const next = resolved.startsWith('glass') ? (dark ? 'glass' : 'glass-dark') : (dark ? 'light' : 'dark');
    setTheme(next);
    api.put('/settings', { theme: next }).catch(() => {});
  }, [resolved, setTheme]);

  return (
    <ThemeCtx.Provider value={{ theme, resolved, setTheme, toggle }}>
      {children}
    </ThemeCtx.Provider>
  );
}