import { useState, useEffect } from 'react';
import { api, postSSE } from '../api.js';
import { useApi } from './useApi.js';
import { Badge, useToast } from './ui.jsx';

const normHost = (u) => (u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

export default function ImagePullPanel() {
  const toast = useToast();
  const { data: registries } = useApi('/registries', { poll: 0 });
  const { data: nodesData } = useApi('/nodes', { poll: 0 });
  const [ref, setRef] = useState('');
  const [regId, setRegId] = useState('');
  const [sel, setSel] = useState(null); // Set of nodeIds
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(null); // { nodes: {nodeId->{hostname,phase,error}}, line, running, done }

  const clusterNodes = (nodesData || []).filter((n) => n.state === 'ready' || !n.state);

  // Default: preselect all ready nodes so the image is available cluster-wide.
  useEffect(() => {
    if (sel === null && clusterNodes.length) setSel(new Set(clusterNodes.map((n) => n.id)));
  }, [nodesData]);

  const toggleNode = (id) => setSel((s) => {
    const n = new Set(s || []); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const pickRegistry = (id) => {
    setRegId(id);
    const reg = (registries || []).find((r) => r.id === id);
    if (reg) {
      const host = normHost(reg.url);
      // Prefill the host prefix if the ref doesn't already start with a registry host.
      if (!ref || !ref.includes('/') || !ref.startsWith(host)) setRef(`${host}/`);
    }
  };

  const pull = async () => {
    const image = ref.trim();
    if (!image) return toast('Bitte eine Image-Referenz eingeben', 'err');
    const nodeIds = [...(sel || [])];
    if (nodeIds.length === 0) return toast('Mindestens einen Node wählen', 'err');
    setBusy(true);
    const nodeState = {};
    for (const id of nodeIds) nodeState[id] = { hostname: clusterNodes.find((n) => n.id === id)?.hostname || id, phase: 'wartet' };
    setProg({ nodes: nodeState, line: '', running: true });
    let errMsg = null;
    try {
      await postSSE('/images/pull', { ref: image, nodeIds }, (e) => {
        if (e.type === 'node') {
          setProg((p) => ({ ...p, nodes: { ...p.nodes, [e.nodeId]: { hostname: e.hostname, phase: e.phase, error: e.error } } }));
        } else if (e.type === 'progress') {
          setProg((p) => ({ ...p, line: e.status || '' }));
        } else if (e.type === 'error') {
          errMsg = e.message;
        } else if (e.type === 'done') {
          setProg((p) => ({ ...p, running: false, done: true, result: e.result }));
        }
      });
      if (errMsg) throw new Error(errMsg);
      toast('Pull abgeschlossen', 'ok');
    } catch (e) {
      setProg((p) => (p ? { ...p, running: false } : null));
      toast(e.message, 'err');
    } finally { setBusy(false); }
  };

  const phaseBadge = (ph, error) => {
    if (ph === 'done') return <Badge kind="ok">fertig</Badge>;
    if (ph === 'error') return <><Badge kind="err">Fehler</Badge>{error ? <span className="help"> {error}</span> : null}</>;
    if (ph === 'start') return <Badge kind="info">lädt…</Badge>;
    return <Badge kind="muted">{ph}</Badge>;
  };

  return (
    <>
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <div className="sub">Image aus einer hinterlegten Registry auf Nodes laden (docker pull)</div>
      </div>

      <div className="card" style={{ maxWidth: 780 }}>
        <div className="form-grid">
          <div className="field">
            <label>Registry (optional — füllt den Host vor)</label>
            <select value={regId} onChange={(e) => pickRegistry(e.target.value)}>
              <option value="">— Docker Hub / manuell —</option>
              {(registries || []).map((r) => (
                <option key={r.id} value={r.id}>{r.name || r.url} ({normHost(r.url)}){r.hasPassword ? ' 🔑' : ''}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Image-Referenz</label>
            <input className="mono" value={ref} onChange={(e) => setRef(e.target.value)}
              placeholder="registry.example.com/team/app:1.2.3" />
          </div>
        </div>
        <div className="help" style={{ marginTop: -4, marginBottom: 10 }}>
          Die Zugangsdaten werden automatisch anhand des Hosts in der Referenz aus den hinterlegten Registries gewählt.
          Ohne passende Registry wird anonym (Docker Hub) gezogen.
        </div>

        <div style={{ fontWeight: 600, marginBottom: 6 }}>Ziel-Nodes</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
          <button className="btn sm" disabled={busy} onClick={() => setSel(new Set(clusterNodes.map((n) => n.id)))}>Alle</button>
          <button className="btn sm" disabled={busy} onClick={() => setSel(new Set())}>Keine</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {clusterNodes.map((n) => {
            const st = prog?.nodes?.[n.id];
            return (
              <label key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={(sel || new Set()).has(n.id)} disabled={busy} onChange={() => toggleNode(n.id)} />
                {n.hostname}
                {n.role === 'manager' && <Badge kind="muted">manager</Badge>}
                {st && phaseBadge(st.phase, st.error)}
              </label>
            );
          })}
        </div>

        <button className="btn primary" disabled={busy || !ref.trim() || !(sel && sel.size)} onClick={pull}>
          {busy ? 'Lädt…' : `Pull auf ${(sel && sel.size) || 0} Node(s)`}
        </button>

        {prog && (
          <div style={{ marginTop: 12 }}>
            {prog.line && <div className="help mono" style={{ fontSize: 12, marginBottom: 8 }}>{prog.line}</div>}
            <table>
              <thead><tr><th>Node</th><th>Status</th></tr></thead>
              <tbody>
                {Object.entries(prog.nodes).map(([id, st]) => (
                  <tr key={id}>
                    <td>{st.hostname}</td>
                    <td>{phaseBadge(st.phase, st.error)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
