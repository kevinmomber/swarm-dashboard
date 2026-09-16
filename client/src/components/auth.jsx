import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken } from '../api.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await onLogin(username, password); }
    catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <form className="card" style={{ width: 340 }} onSubmit={submit}>
        <div className="brand" style={{ justifyContent: 'center', paddingBottom: 20 }}>
          <span className="logo">⬡</span><span>Swarm Dashboard</span>
        </div>
        <div className="field">
          <label>Benutzername</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Passwort</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {err && <div className="toast err" style={{ position: 'static', marginBottom: 12 }}>{err}</div>}
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Anmelden…' : 'Anmelden'}
        </button>
      </form>
    </div>
  );
}

export function AuthProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [user, setUser] = useState(null);

  const bootstrap = useCallback(async () => {
    try {
      const st = await api.get('/auth/status');
      setEnabled(st.enabled);
      if (st.enabled && getToken()) {
        try { const me = await api.get('/auth/me'); setUser(me.user); }
        catch { setUser(null); }
      } else {
        setUser(null);
      }
    } catch { setEnabled(false); }
    finally { setReady(true); }
  }, []);

  useEffect(() => { bootstrap(); }, [bootstrap]);

  useEffect(() => {
    const onUnauth = () => setUser(null);
    window.addEventListener('swarmdash-unauth', onUnauth);
    return () => window.removeEventListener('swarmdash-unauth', onUnauth);
  }, []);

  const login = useCallback(async (username, password) => {
    const r = await api.post('/auth/login', { username, password });
    setToken(r.token);
    setUser(r.user);
  }, []);

  const logout = useCallback(() => {
    api.post('/auth/logout').catch(() => {});
    setToken(null);
    setUser(null);
  }, []);

  const value = { enabled, user, login, logout, refresh: bootstrap };

  if (!ready) return <div className="spinner" style={{ marginTop: '20vh' }}>Lade…</div>;
  if (enabled && !user) return <AuthCtx.Provider value={value}><Login onLogin={login} /></AuthCtx.Provider>;
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
