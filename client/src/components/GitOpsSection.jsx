import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from './useApi.js';
import { Badge, ago, Modal, useToast } from './ui.jsx';

const statusKind = (s) => (s === 'deployed' ? 'ok' : s === 'error' ? 'err' : s === 'unchanged' ? 'muted' : 'info');

function GitOpsForm({ repos, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', gitId: repos[0]?.id || '', stackName: '', composePath: 'docker-compose.yml', autoDeploy: true, intervalMin: 5 });
  const [busy, setBusy] = useState(false);
  const set = (p) => setF({ ...f, ...p });

  const save = async () => {
    if (!f.name.trim() || !f.stackName.trim() || !f.gitId) { toast('Name, Git-Repo und Stack-Name erforderlich', 'err'); return; }
    setBusy(true);
    try { await api.post('/git/ops', f); toast(`GitOps „${f.name}" angelegt`); onSaved(); onClose(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title="🔁 GitOps-Verknüpfung anlegen" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={busy} onClick={save}>＋ Anlegen</button></>}>
      <div className="field"><label>Name *</label><input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="prod-web" autoFocus /></div>
      <div className="field"><label>Git-Repository *</label>
        <select value={f.gitId} onChange={(e) => set({ gitId: e.target.value })}>
          {repos.length === 0 && <option value="">– kein Git-Repo konfiguriert –</option>}
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.branch})</option>)}
        </select>
      </div>
      <div className="field"><label>Stack-Name *</label><input value={f.stackName} onChange={(e) => set({ stackName: e.target.value })} placeholder="mein-stack" /></div>
      <div className="field"><label>Compose-Pfad im Repo</label><input value={f.composePath} onChange={(e) => set({ composePath: e.target.value })} placeholder="docker-compose.yml" /></div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.autoDeploy} onChange={(e) => set({ autoDeploy: e.target.checked })} />
          Automatisch deployen
        </label>
        <div className="field" style={{ margin: 0 }}><label>Intervall (Min)</label><input type="number" min="1" style={{ width: 90 }} value={f.intervalMin} onChange={(e) => set({ intervalMin: Number(e.target.value) })} /></div>
      </div>
      <div className="help" style={{ marginTop: 8 }}>Der Compose-Inhalt wird periodisch aus dem Repo geladen; bei Änderung wird der Stack automatisch neu deployt.</div>
    </Modal>
  );
}

export default function GitOpsSection() {
  const toast = useToast();
  const { data, loading, reload } = useApi('/git/ops', { poll: 15000 });
  const { data: repos } = useApi('/git', { poll: 0 });
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const sync = async (e, force) => {
    setBusyId(e.id);
    try {
      const r = await api.post(`/git/ops/${e.id}/sync`, { force });
      toast(r.deployed ? `„${e.name}" deployed (${r.sha?.slice(0, 7) || ''})` : r.error ? `Fehler: ${r.error}` : `„${e.name}" unverändert`, r.error ? 'err' : 'ok');
      reload();
    } catch (err) { toast(err.message, 'err'); } finally { setBusyId(null); }
  };
  const del = async (e) => {
    if (!window.confirm(`GitOps-Verknüpfung „${e.name}" entfernen?`)) return;
    try { await api.del(`/git/ops/${e.id}`); toast('Entfernt'); reload(); } catch (err) { toast(err.message, 'err'); }
  };

  const repoName = (id) => (repos || []).find((r) => r.id === id)?.name || id;

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div><h2 style={{ margin: 0 }}>GitOps — Auto-Deploy</h2>
          <div className="help">Hält Swarm-Stacks mit einer Compose-Datei aus einem Git-Repo synchron (periodischer Abgleich + Auto-Deploy bei Änderung).</div>
        </div>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn primary" disabled={!repos || repos.length === 0} onClick={() => setAdding(true)}>＋ Verknüpfung anlegen</button>
      </div>
      {(!repos || repos.length === 0) && <div className="banner" style={{ marginBottom: 10 }}>Zuerst unter „Registries & Git" ein Git-Repo konfigurieren.</div>}
      {loading && !data && <div className="spinner">Lade…</div>}
      {data && data.length === 0 && <div className="empty">Keine GitOps-Verknüpfungen.</div>}
      {data && data.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th>Repo → Stack</th><th>Auto</th><th>Status</th><th>Zuletzt</th><th>Aktion</th></tr></thead>
          <tbody>
            {data.map((e) => (
              <tr key={e.id}>
                <td style={{ fontWeight: 600 }}>{e.name}</td>
                <td className="mono" style={{ fontSize: 12 }}>{repoName(e.gitId)}:{e.composePath} → {e.stackName}</td>
                <td>{e.autoDeploy ? <Badge kind="ok">alle {e.intervalMin}m</Badge> : <Badge kind="muted">manuell</Badge>}</td>
                <td>{e.lastStatus ? <Badge kind={statusKind(e.lastStatus)}>{e.lastStatus}</Badge> : '–'}{e.lastError && <div style={{ color: 'var(--red)', fontSize: 11 }}>{e.lastError}</div>}</td>
                <td className="help">{e.lastCheckedAt ? ago(e.lastCheckedAt) : '–'}{e.lastSha ? ` · ${e.lastSha.slice(0, 7)}` : ''}</td>
                <td>
                  <div className="actions">
                    <button className="btn sm" disabled={busyId === e.id} onClick={() => sync(e, false)}>{busyId === e.id ? '…' : 'Sync'}</button>
                    <button className="btn sm" disabled={busyId === e.id} onClick={() => sync(e, true)}>Force-Deploy</button>
                    <button className="btn sm danger" onClick={() => del(e)}>Entfernen</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {adding && <GitOpsForm repos={repos || []} onClose={() => setAdding(false)} onSaved={reload} />}
    </div>
  );
}
