import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const KEY = 'swarmdash.theme';
const ThemeCtx = createContext({ theme: 'dark', setTheme: () => {}, toggle: () => {} });
export const useTheme = () => useContext(ThemeCtx);

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(
    () => localStorage.getItem(KEY) || 'dark'
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Reconcile with server-stored preference once on mount.
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s?.theme && s.theme !== localStorage.getItem(KEY)) {
          localStorage.setItem(KEY, s.theme);
          setThemeState(s.theme);
        }
      })
      .catch(() => {});
  }, []);

  const setTheme = useCallback((t) => {
    localStorage.setItem(KEY, t);
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return (
    <ThemeCtx.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeCtx.Provider>
  );
}
