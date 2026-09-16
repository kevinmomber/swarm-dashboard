import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Modal, Badge, bytes, useToast } from './ui.jsx';

export default function RestoreModal({ onClose }) {
  const toast = useToast();
  const [archives, setArchives] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState({}); // volume -> file
  const [clean, setClean] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/backup/archives').then(setArchives).catch((e) => setErr(e.message));
  }, []);

  const restore = async (volume) => {
    const file = sel[volume];
    if (!file) return toast('Bitte ein Archiv wählen', 'err');
    if (!confirm(`"${file}" in Volume "${volume}" zurückspielen?${clean ? ' Volume wird zuvor geleert!' : ''}`)) return;
    setBusy(true);
    try {
      await api.post('/backup/restore', { volume, file, clean });
      toast(`${volume} wiederhergestellt`);
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
        return (
          <div className="card" key={vol} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div className="pill-group">
                <Badge kind={entry.type === 'bind' ? 'warn' : 'info'}>{entry.type === 'bind' ? 'bind' : 'volume'}</Badge>
                <span className="mono" style={{ fontSize: 12 }}>{entry.label}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flex: 1, maxWidth: 520 }}>
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
