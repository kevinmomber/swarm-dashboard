import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { Badge, useToast } from './ui.jsx';
import { useAuth } from './auth.jsx';

export default function AuthSection() {
  const toast = useToast();
  const { enabled, user, refresh } = useAuth();
  const [status, setStatus] = useState(null);
  const [users, setUsers] = useState([]);
  const [nu, setNu] = useState({ username: '', password: '', role: 'admin' });
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const st = await api.get('/auth/status');
      setStatus(st);
      if (st.hasUsers) { try { setUsers(await api.get('/auth/users')); } catch { setUsers([]); } }
      else setUsers([]);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const addUser = async () => {
    if (!nu.username || !nu.password) return toast('Benutzername und Passwort erforderlich', 'err');
    setBusy(true);
    try {
      await api.post('/auth/users', nu);
      toast(`Benutzer "${nu.username}" angelegt`);
      setNu({ username: '', password: '', role: 'admin' });
      await load(); refresh();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const delUser = async (username) => {
    if (!confirm(`Benutzer "${username}" löschen?`)) return;
    setBusy(true);
    try { await api.del(`/auth/users/${username}`); toast('Benutzer gelöscht'); await load(); refresh(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const toggleEnabled = async (val) => {
    setBusy(true);
    try { await api.post('/auth/enable', { enabled: val }); toast(val ? 'Authentifizierung aktiviert' : 'Authentifizierung deaktiviert'); await load(); refresh(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const changePw = async () => {
    if (!pw) return;
    setBusy(true);
    try { await api.post('/auth/password', { password: pw }); toast('Passwort geändert'); setPw(''); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="card section">
      <h2>Authentifizierung</h2>
      <div className="desc">Lokale Benutzerverwaltung. Ohne Benutzer ist das Dashboard offen erreichbar.</div>

      <div className="form-row">
        <div className="rl">
          <div className="t">Authentifizierung aktiv</div>
          <div className="h">Schützt API und WebSockets mit Login. Erfordert mindestens einen Benutzer.</div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={!!status?.enabled} disabled={busy || !status?.hasUsers}
            onChange={(e) => toggleEnabled(e.target.checked)} />
          <span className="slider" />
        </label>
      </div>

      <div style={{ marginTop: 10 }}>
        <label>Benutzer</label>
        {users.length === 0
          ? <div className="empty" style={{ padding: 16 }}>Noch kein Benutzer. Legen Sie den ersten Admin an.</div>
          : (
            <table style={{ marginTop: 6 }}>
              <thead><tr><th>Benutzer</th><th>Rolle</th><th>Aktion</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.username}>
                    <td style={{ fontWeight: 600 }}>{u.username}</td>
                    <td><Badge kind={u.role === 'admin' ? 'info' : u.role === 'operator' ? 'warn' : 'muted'}>{u.role}</Badge></td>
                    <td><button className="btn sm danger" disabled={busy} onClick={() => delUser(u.username)}>Löschen</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      <div className="form-grid" style={{ marginTop: 14 }}>
        <div className="field"><label>Neuer Benutzer</label>
          <input value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} placeholder="admin" /></div>
        <div className="field"><label>Passwort</label>
          <input type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} /></div>
        <div className="field"><label>Rolle</label>
          <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
            <option value="admin">admin</option>
            <option value="operator">operator</option>
            <option value="viewer">viewer</option>
          </select></div>
        <div className="field" style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button className="btn primary" disabled={busy} onClick={addUser}>Benutzer anlegen</button>
        </div>
      </div>

      {enabled && user && (
        <div className="form-row" style={{ marginTop: 6 }}>
          <div className="rl"><div className="t">Eigenes Passwort ändern</div><div className="h">Angemeldet als {user.username}</div></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="password" style={{ width: 200 }} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Neues Passwort" />
            <button className="btn" disabled={busy || !pw} onClick={changePw}>Ändern</button>
          </div>
        </div>
      )}
    </div>
  );
}
