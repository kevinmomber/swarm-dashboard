import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { Badge, Modal, useToast } from './ui.jsx';

export default function RegistriesGitSection() {
  const toast = useToast();
  const [regs, setRegs] = useState([]);
  const [git, setGit] = useState([]);
  const [nr, setNr] = useState({ name: '', url: '', username: '', password: '' });
  const [ng, setNg] = useState({ name: '', url: '', branch: 'main', composePath: 'docker-compose.yml', token: '' });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    try { setRegs(await api.get('/registries')); setGit(await api.get('/git')); } catch { /* ignore */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const addReg = async () => {
    if (!nr.url) return toast('Registry-URL erforderlich', 'err');
    setBusy(true);
    try { await api.post('/registries', nr); toast('Registry hinzugefügt'); setNr({ name: '', url: '', username: '', password: '' }); load(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const delReg = async (id) => { if (!confirm('Registry löschen?')) return; try { await api.del(`/registries/${id}`); load(); } catch (e) { toast(e.message, 'err'); } };
  const testReg = async (id) => { setBusy(true); try { const r = await api.post(`/registries/${id}/test`); toast(r.status || 'Login OK'); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); } };

  const addGit = async () => {
    if (!ng.url) return toast('Repository-URL erforderlich', 'err');
    setBusy(true);
    try { await api.post('/git', ng); toast('Repository hinzugefügt'); setNg({ name: '', url: '', branch: 'main', composePath: 'docker-compose.yml', token: '' }); load(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const delGit = async (id) => { if (!confirm('Repository löschen?')) return; try { await api.del(`/git/${id}`); load(); } catch (e) { toast(e.message, 'err'); } };
  const fetchGit = async (id) => {
    setBusy(true);
    try { const r = await api.post(`/git/${id}/fetch`); setPreview({ compose: r.compose, path: r.composePath }); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const downloadPreview = () => {
    const blob = new Blob([preview.compose], { type: 'text/yaml' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'compose-from-git.yml';
    document.body.appendChild(a); a.click(); a.remove();
  };

  return (
    <div className="card section">
      <h2>Registries &amp; Git</h2>
      <div className="desc">Weitere Image-Registries für authentifizierte Pulls sowie Git-Repositories zum Beziehen von Compose-Dateien.</div>

      <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Registries</h3>
      {regs.length === 0 ? <div className="help">Keine Registries konfiguriert.</div> : (
        <table style={{ marginBottom: 10 }}>
          <thead><tr><th>Name</th><th>URL</th><th>Benutzer</th><th>Aktion</th></tr></thead>
          <tbody>
            {regs.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{r.name}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.url}</td>
                <td>{r.username || '–'} {r.hasPassword && <Badge kind="muted">🔑</Badge>}</td>
                <td><div className="actions">
                  <button className="btn sm" disabled={busy} onClick={() => testReg(r.id)}>Test</button>
                  <button className="btn sm danger" onClick={() => delReg(r.id)}>Löschen</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form-grid">
        <div className="field"><label>Name</label><input value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} placeholder="Meine Registry" /></div>
        <div className="field"><label>URL / Host</label><input value={nr.url} onChange={(e) => setNr({ ...nr, url: e.target.value })} placeholder="registry.example.com" /></div>
        <div className="field"><label>Benutzer</label><input value={nr.username} onChange={(e) => setNr({ ...nr, username: e.target.value })} /></div>
        <div className="field"><label>Passwort / Token</label><input type="password" value={nr.password} onChange={(e) => setNr({ ...nr, password: e.target.value })} /></div>
      </div>
      <div className="actions"><button className="btn primary" disabled={busy} onClick={addReg}>Registry hinzufügen</button></div>

      <h3 style={{ margin: '18px 0 4px', fontSize: 14 }}>Git-Repositories</h3>
      {git.length === 0 ? <div className="help">Keine Repositories konfiguriert.</div> : (
        <table style={{ marginBottom: 10 }}>
          <thead><tr><th>Name</th><th>URL</th><th>Branch</th><th>Compose-Pfad</th><th>Aktion</th></tr></thead>
          <tbody>
            {git.map((g) => (
              <tr key={g.id}>
                <td style={{ fontWeight: 600 }}>{g.name}</td>
                <td className="mono" style={{ fontSize: 12 }}>{g.url}</td>
                <td>{g.branch}</td>
                <td className="mono" style={{ fontSize: 12 }}>{g.composePath} {g.hasToken && <Badge kind="muted">🔑</Badge>}</td>
                <td><div className="actions">
                  <button className="btn sm" disabled={busy} onClick={() => fetchGit(g.id)}>Compose laden</button>
                  <button className="btn sm danger" onClick={() => delGit(g.id)}>Löschen</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form-grid">
        <div className="field"><label>Name</label><input value={ng.name} onChange={(e) => setNg({ ...ng, name: e.target.value })} placeholder="Mein Repo" /></div>
        <div className="field"><label>Repository-URL (https)</label><input value={ng.url} onChange={(e) => setNg({ ...ng, url: e.target.value })} placeholder="https://github.com/user/repo.git" /></div>
        <div className="field"><label>Branch</label><input value={ng.branch} onChange={(e) => setNg({ ...ng, branch: e.target.value })} /></div>
        <div className="field"><label>Compose-Pfad</label><input value={ng.composePath} onChange={(e) => setNg({ ...ng, composePath: e.target.value })} /></div>
        <div className="field"><label>Token (für private Repos)</label><input type="password" value={ng.token} onChange={(e) => setNg({ ...ng, token: e.target.value })} /></div>
      </div>
      <div className="actions"><button className="btn primary" disabled={busy} onClick={addGit}>Repository hinzufügen</button></div>

      {preview && (
        <Modal wide title={`Compose · ${preview.path}`} onClose={() => setPreview(null)}
          footer={<><button className="btn" onClick={() => setPreview(null)}>Schließen</button><button className="btn primary" onClick={downloadPreview}>Als .yml speichern</button></>}>
          <div className="help" style={{ marginBottom: 8 }}>Zum Deployen im Bereich <b>Stacks → Import</b> laden.</div>
          <pre className="log-view" style={{ height: 360 }}>{preview.compose}</pre>
        </Modal>
      )}
    </div>
  );
}
