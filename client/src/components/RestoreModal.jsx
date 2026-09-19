import { useState, useEffect } from 'react';
import { api, postSSE } from '../api.js';
import { Modal, Badge, bytes, useToast } from './ui.jsx';

export default function RestoreModal({ onClose }) {
  const toast = useToast();
  const [tab, setTab] = useState('volumes');
  const [archives, setArchives] = useState(null);
  const [specs, setSpecs] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState({}); // volume -> file
  const [nodeSel, setNodeSel] = useState({}); // volume -> nodeId override
  const [specSel, setSpecSel] = useState({}); // service -> file
  const [clean, setClean] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viewSpec, setViewSpec] = useState(null); // { name, json }
  const [fullProg, setFullProg] = useState(null); // { service, items, running }

  useEffect(() => {
    api.get('/backup/archives').then(setArchives).catch((e) => setErr(e.message));
    api.get('/backup/service-specs').then(setSpecs).catch(() => setSpecs({}));
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

  const latestSpecFile = (svc) => specSel[svc] || specs?.[svc]?.[0]?.file || '';

  const showSpec = async (svc) => {
    const file = latestSpecFile(svc);
    if (!file) return;
    setBusy(true);
    try {
      const meta = await api.get(`/backup/service-spec?file=${encodeURIComponent(file)}`);
      setViewSpec({ name: svc, savedAt: meta.savedAt, json: JSON.stringify(meta.spec, null, 2) });
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const restoreSpecOnly = async (svc) => {
    const file = latestSpecFile(svc);
    if (!file) return toast('Bitte eine Spec-Version wählen', 'err');
    if (!confirm(`Service „${svc}" aus Konfiguration wiederherstellen?\nEin bestehender Service wird aktualisiert, sonst neu erstellt.`)) return;
    setBusy(true);
    try {
      const r = await api.post('/backup/restore-service', { file });
      toast(`Service „${r.name}" ${r.action === 'created' ? 'neu erstellt' : 'aktualisiert'}`);
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const restoreFull = async (svc) => {
    const file = latestSpecFile(svc);
    if (!file) return toast('Bitte eine Spec-Version wählen', 'err');
    if (!confirm(`Service „${svc}" komplett wiederherstellen?\nZuerst werden die Volume-Daten (neueste Archive) zurückgespielt (Volumes werden geleert!), danach der Service aus der Konfiguration erstellt/aktualisiert.`)) return;
    setBusy(true);
    setFullProg({ service: svc, items: [], running: true });
    let errMsg = null;
    try {
      await postSSE('/backup/restore-service-full', { file, clean: true }, (ev) => {
        if (ev.type === 'volume') {
          setFullProg((p) => {
            if (!p) return p;
            const items = [...p.items];
            const i = items.findIndex((x) => x.name === ev.name);
            const state = ev.phase === 'restore' ? 'restore' : (ev.ok ? 'done' : 'failed');
            const row = { name: ev.name, state, error: ev.error || null };
            if (i >= 0) items[i] = row; else items.push(row);
            return { ...p, items };
          });
        } else if (ev.type === 'service') {
          setFullProg((p) => (p ? { ...p, svcPhase: ev.phase, action: ev.action } : p));
        } else if (ev.type === 'error') {
          errMsg = ev.message;
        } else if (ev.type === 'done') {
          setFullProg((p) => ({ ...(p || { items: [] }), running: false, result: ev.result }));
        }
      });
      if (errMsg) throw new Error(errMsg);
      toast(`Service „${svc}" wiederhergestellt`);
    } catch (e) {
      setFullProg((p) => (p ? { ...p, running: false, error: e.message } : null));
      toast(e.message, 'err');
    } finally { setBusy(false); }
  };

  const vols = archives ? Object.keys(archives) : [];
  const svcs = specs ? Object.keys(specs) : [];

  return (
    <Modal wide title="Restore — Wiederherstellen" onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Schließen</button>}>
      {err && <div className="banner">{err}</div>}

      <div className="pill-group" style={{ marginBottom: 14 }}>
        <button className={`btn ${tab === 'volumes' ? 'primary' : ''}`} onClick={() => setTab('volumes')}>Volumes / Daten{vols.length ? ` (${vols.length})` : ''}</button>
        <button className={`btn ${tab === 'services' ? 'primary' : ''}`} onClick={() => setTab('services')}>Services / Konfiguration{svcs.length ? ` (${svcs.length})` : ''}</button>
      </div>

      {tab === 'volumes' && (<>
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
      </>)}

      {tab === 'services' && (<>
        {!specs && <div className="help">Lade Service-Konfigurationen vom Ziel…</div>}
        {specs && svcs.length === 0 && <div className="empty" style={{ padding: 24 }}>Keine gesicherten Service-Konfigurationen gefunden.</div>}
        {svcs.length > 0 && (
          <div className="help" style={{ marginBottom: 10 }}>
            „Nur Konfiguration" erstellt/aktualisiert den Service aus der gesicherten Spec.
            „Service + Daten" spielt zusätzlich die neuesten Volume-Archive zurück (Volumes werden geleert) und erstellt dann den Service.
            Hinweis: referenzierte Secrets/Configs müssen vorhanden sein.
          </div>
        )}

        {svcs.map((svc) => {
          const list = specs[svc] || [];
          const cur = latestSpecFile(svc);
          return (
            <div className="card" key={svc} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div className="pill-group">
                  <Badge kind="info">Service</Badge>
                  <span className="mono" style={{ fontSize: 12 }}>{svc}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <select value={cur} onChange={(e) => setSpecSel({ ...specSel, [svc]: e.target.value })} title="Konfigurations-Version" style={{ maxWidth: 260 }}>
                    {list.map((a) => <option key={a.file} value={a.file}>{a.file} ({bytes(a.bytes)})</option>)}
                  </select>
                  <button className="btn" disabled={busy} onClick={() => showSpec(svc)}>Anzeigen</button>
                  <button className="btn" disabled={busy} onClick={() => restoreSpecOnly(svc)}>Nur Konfiguration</button>
                  <button className="btn primary" disabled={busy} onClick={() => restoreFull(svc)}>Service + Daten</button>
                </div>
              </div>
              {fullProg && fullProg.service === svc && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div className="help" style={{ marginBottom: 6 }}>
                    {fullProg.running ? 'Wiederherstellung läuft…' : fullProg.error ? `Fehler: ${fullProg.error}` : 'Fertig'}
                    {fullProg.svcPhase === 'apply' && ' · Service wird angewandt…'}
                    {fullProg.action && ` · Service ${fullProg.action === 'created' ? 'erstellt' : 'aktualisiert'}`}
                  </div>
                  {fullProg.items.map((it) => (
                    <div key={it.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span className="mono" style={{ fontSize: 12 }}>{it.name}</span>
                      <Badge kind={it.state === 'done' ? 'ok' : it.state === 'failed' ? 'err' : 'info'}>
                        {it.state === 'restore' ? 'stelle wieder her…' : it.state === 'done' ? 'fertig' : it.state === 'failed' ? (it.error || 'Fehler') : it.state}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </>)}

      {viewSpec && (
        <Modal wide title={`Konfiguration · ${viewSpec.name}`} onClose={() => setViewSpec(null)}
          footer={<>
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(viewSpec.json); toast('Kopiert'); }}>Kopieren</button>
            <button className="btn primary" onClick={() => setViewSpec(null)}>Schließen</button>
          </>}>
          {viewSpec.savedAt && <div className="help" style={{ marginBottom: 8 }}>Gesichert: {new Date(viewSpec.savedAt).toLocaleString('de-DE')}</div>}
          <pre style={{ margin: 0, maxHeight: '60vh', overflow: 'auto', background: 'var(--panel2, #0d1117)', padding: 12, borderRadius: 8, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre' }}>{viewSpec.json}</pre>
        </Modal>
      )}
    </Modal>
  );
}
