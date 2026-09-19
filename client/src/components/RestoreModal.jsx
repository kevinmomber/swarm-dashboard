import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Modal, Badge, bytes, useToast } from './ui.jsx';

export default function RestoreModal({ onClose }) {
  const toast = useToast();
  const [archives, setArchives] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState({}); // volume -> file
  const [nodeSel, setNodeSel] = useState({}); // volume -> nodeId override
  const [clean, setClean] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/backup/archives').then(setArchives).catch((e) => setErr(e.message));
    api.get('/nodes').then((ns) => setNodes((ns || []).filter((n) => n.state === 'ready'))).catch(() => {});
  }, []);

  const restore = async (volume) => {
    const file = sel[volume];
    if (!file) return toast('Bitte ein Archiv wählen', 'err');
    const entry = archives[volume];
    const targetNode = nodeSel[volume] || entry.nodeId || '';
    const nodeLabel = nodes.find((n) => n.id === targetNode)?.hostname || entry.hostname || 'Manager';
    if (!confirm(`"${file}" in Volume "${volume}" auf Node „${nodeLabel}" zurückspielen?${clean ? ' Volume wird zuvor geleert!' : ''}`)) return;
    setBusy(true);
    try {
      await api.post('/backup/restore', { volume, file, clean, nodeId: targetNode || null });
      toast(`${volume} wiederhergestellt (${nodeLabel})`);
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const vols = archives ? Object.keys(archives) : [];

  return (
    <Modal wide title="Restore — Archiv zurückspielen" onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Schließen</button>}>
      {err && <div className="banner">{err}</div>}
      {!archives && !err && <div className="help">Lade Archive vom Ziel…</div>}
      {archives && vols.length === 0 && <div className="empty" style={{ padding: 24 }}>Keine Archive im Ziel gefunden.</div>}

      <div className="field" style={{ display: vols.length ? 'flex' : 'none', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={clean} onChange={(e) => setClean(e.target.checked)} />
        <span className="help">Ziel vor dem Zurückspielen leeren (sauberer Restore)</span>
      </div>

      {vols.map((vol) => {
        const entry = archives[vol];
        const isBind = entry.type === 'bind';
        const curNode = nodeSel[vol] || entry.nodeId || '';
        return (
          <div className="card" key={vol} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div className="pill-group">
                <Badge kind={isBind ? 'warn' : 'info'}>{isBind ? 'bind' : 'volume'}</Badge>
                <span className="mono" style={{ fontSize: 12 }}>{entry.label}</span>
                {entry.hostname && <Badge kind="muted">Node: {entry.hostname}</Badge>}
              </div>
              <div style={{ display: 'flex', gap: 8, flex: 1, maxWidth: 620, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {!isBind && (
                  <select value={curNode} onChange={(e) => setNodeSel({ ...nodeSel, [vol]: e.target.value })} title="Ziel-Node" style={{ maxWidth: 200 }}>
                    <option value="">{entry.hostname ? `Auto (${entry.hostname})` : 'Auto / Manager'}</option>
                    {nodes.map((n) => <option key={n.id} value={n.id}>{n.hostname}</option>)}
                  </select>
                )}
                <select value={sel[vol] || ''} onChange={(e) => setSel({ ...sel, [vol]: e.target.value })}>
                  <option value="">— Archiv wählen —</option>
                  {entry.archives.map((a) => (
                    <option key={a.file} value={a.file}>{a.file} ({bytes(a.bytes)})</option>
                  ))}
                </select>
                <button className="btn primary" disabled={busy} onClick={() => restore(vol)}>Restore</button>
              </div>
            </div>
          </div>
        );
      })}
    </Modal>
  );
}
