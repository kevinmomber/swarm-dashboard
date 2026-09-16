import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Modal, useToast } from './ui.jsx';
import TabBar from './TabBar.jsx';
import LayersView from './LayersView.jsx';
import ProcessesView from './ProcessesView.jsx';
import FileBrowser from './FileBrowser.jsx';

const RESTART = ['no', 'on-failure', 'always', 'unless-stopped'];

/**
 * Edit + redeploy a standalone (non-swarm) container. Fetches the current
 * config, lets the user change image, ports, env, command and restart policy,
 * then recreates the container (stop → remove → create → start).
 */
export default function ContainerEditModal({ container, onClose, onDone }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const [image, setImage] = useState('');
  const [restartPolicy, setRestartPolicy] = useState('no');
  const [ports, setPorts] = useState([]);
  const [envText, setEnvText] = useState('');
  const [cmdText, setCmdText] = useState('');
  const [origCmd, setOrigCmd] = useState('');
  const [mounts, setMounts] = useState([]);
  const [networks, setNetworks] = useState([]);
  const [availableNetworks, setAvailableNetworks] = useState([]);
  const [tab, setTab] = useState('general');
  const running = container.state === 'running';

  useEffect(() => {
    let alive = true;
    api.get(`/containers/config?nodeId=${encodeURIComponent(container.nodeId)}&id=${encodeURIComponent(container.id)}`)
      .then((c) => {
        if (!alive) return;
        setCfg(c);
        setImage(c.image || '');
        setRestartPolicy(c.restartPolicy || 'no');
        setPorts((c.ports || []).map((p) => ({ hostPort: p.hostPort || '', containerPort: p.containerPort || '', proto: p.proto || 'tcp' })));
        setEnvText((c.env || []).join('\n'));
        setCmdText((c.cmd || []).join(' '));
        setOrigCmd((c.cmd || []).join(' '));
        setMounts((c.mounts || []).map((m) => ({ type: m.type || 'volume', source: m.source || '', target: m.target || '', readOnly: !!m.readOnly })));
        setNetworks(c.networks || []);
        setAvailableNetworks(c.availableNetworks || []);
      })
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [container]);

  const setPort = (i, key, val) => setPorts((ps) => ps.map((p, idx) => (idx === i ? { ...p, [key]: val } : p)));
  const addPort = () => setPorts((ps) => [...ps, { hostPort: '', containerPort: '', proto: 'tcp' }]);
  const removePort = (i) => setPorts((ps) => ps.filter((_, idx) => idx !== i));

  const setMount = (i, key, val) => setMounts((ms) => ms.map((m, idx) => (idx === i ? { ...m, [key]: val } : m)));
  const addMount = () => setMounts((ms) => [...ms, { type: 'volume', source: '', target: '', readOnly: false }]);
  const removeMount = (i) => setMounts((ms) => ms.filter((_, idx) => idx !== i));
  const toggleNet = (name) => setNetworks((ns) => (ns.includes(name) ? ns.filter((n) => n !== name) : [...ns, name]));

  const save = async () => {
    const patch = {
      image: image.trim(),
      restartPolicy,
      env: envText.split('\n').map((l) => l.trim()).filter(Boolean),
      ports: ports
        .filter((p) => String(p.containerPort).trim())
        .map((p) => ({ containerPort: String(p.containerPort).trim(), proto: p.proto || 'tcp', hostPort: String(p.hostPort).trim() })),
      mounts: mounts
        .filter((m) => m.source.trim() && m.target.trim())
        .map((m) => ({ type: m.type, source: m.source.trim(), target: m.target.trim(), readOnly: !!m.readOnly })),
      networks,
    };
    const cmdTrim = cmdText.trim();
    // Only send cmd when the user actually changed it — naive whitespace
    // splitting would otherwise corrupt multi-word arguments (e.g. "daemon off;").
    if (cmdTrim && cmdText !== origCmd) patch.cmd = cmdTrim.split(/\s+/);
    setBusy(true);
    try {
      const r = await api.post('/containers/recreate', { nodeId: container.nodeId, id: container.id, patch });
      toast(r.started ? `Container „${r.name}" neu deployt & gestartet` : `Container „${r.name}" neu deployt`, 'ok');
      onDone?.();
      onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal
      wide
      title={`Bearbeiten & Redeploy · ${container.name}`}
      onClose={onClose}
      footer={tab === 'general' ? <>
        <button className="btn" onClick={onClose}>Abbrechen</button>
        <button className="btn primary" disabled={busy || !cfg} onClick={save}>Speichern & Redeploy</button>
      </> : <button className="btn" onClick={onClose}>Schließen</button>}
    >
      <TabBar
        active={tab}
        onChange={setTab}
        tabs={[
          { k: 'general', label: 'Allgemein' },
          { k: 'layers', label: 'Layer' },
          { k: 'proc', label: 'Prozesse', disabled: !running },
          { k: 'files', label: 'Dateien', disabled: !running },
        ]}
      />
      <div className="edit-tabpanel">
      {tab === 'layers' && <LayersView nodeId={container.nodeId} image={container.image} />}
      {tab === 'proc' && <ProcessesView nodeId={container.nodeId} containerId={container.id} />}
      {tab === 'files' && <FileBrowser nodeId={container.nodeId} containerId={container.id} />}
      {tab === 'general' && <>
      {err && <div className="banner">{err}</div>}
      {!cfg && !err && <div className="help">Lade Konfiguration…</div>}
      {cfg && (
        <>
          <div className="help" style={{ marginBottom: 10 }}>
            Der Container wird mit der neuen Konfiguration neu erstellt (stop → remove → create → start). Name, Volumes und Netzwerke bleiben erhalten.
          </div>
          <div className="field">
            <label>Image</label>
            <input value={image} onChange={(e) => setImage(e.target.value)} placeholder="repo/image:tag" />
          </div>
          <div className="field">
            <label>Restart-Policy</label>
            <select value={restartPolicy} onChange={(e) => setRestartPolicy(e.target.value)}>
              {RESTART.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Ports (Host → Container)</label>
            {ports.map((p, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <input style={{ width: 90 }} value={p.hostPort} onChange={(e) => setPort(i, 'hostPort', e.target.value)} placeholder="Host" />
                <span>→</span>
                <input style={{ width: 90 }} value={p.containerPort} onChange={(e) => setPort(i, 'containerPort', e.target.value)} placeholder="Container" />
                <select style={{ width: 80 }} value={p.proto} onChange={(e) => setPort(i, 'proto', e.target.value)}>
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </select>
                <button className="btn sm danger" onClick={() => removePort(i)}>✕</button>
              </div>
            ))}
            <button className="btn sm" onClick={addPort}>+ Port</button>
            <div className="help" style={{ marginTop: 4 }}>Host leer lassen = nur exponieren, keine Veröffentlichung.</div>
          </div>
          <div className="field">
            <label>Umgebungsvariablen (eine pro Zeile, KEY=VALUE)</label>
            <textarea rows={6} value={envText} onChange={(e) => setEnvText(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </div>
          <div className="field">
            <label>Volumes / Mounts (Quelle → Ziel)</label>
            {mounts.map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <select style={{ width: 90 }} value={m.type} onChange={(e) => setMount(i, 'type', e.target.value)}>
                  <option value="volume">volume</option>
                  <option value="bind">bind</option>
                </select>
                <input style={{ flex: 1 }} value={m.source} onChange={(e) => setMount(i, 'source', e.target.value)} placeholder={m.type === 'bind' ? '/host/pfad' : 'volume-name'} />
                <span>→</span>
                <input style={{ flex: 1 }} value={m.target} onChange={(e) => setMount(i, 'target', e.target.value)} placeholder="/container/pfad" />
                <label className="help" style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={m.readOnly} onChange={(e) => setMount(i, 'readOnly', e.target.checked)} /> ro
                </label>
                <button className="btn sm danger" onClick={() => removeMount(i)}>✕</button>
              </div>
            ))}
            <button className="btn sm" onClick={addMount}>+ Mount</button>
          </div>
          <div className="field">
            <label>Netzwerke</label>
            {availableNetworks.length === 0 ? (
              <div className="help">Keine Netzwerke gefunden.</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {availableNetworks.map((n) => (
                  <label key={n} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px' }}>
                    <input type="checkbox" checked={networks.includes(n)} onChange={() => toggleNet(n)} />
                    {n}
                  </label>
                ))}
              </div>
            )}
            <div className="help" style={{ marginTop: 4 }}>Das erste ausgewählte Netzwerk wird beim Erstellen verbunden, weitere danach angehängt.</div>
          </div>
          <div className="field">
            <label>Command (optional, leer = Image-Default beibehalten)</label>
            <input value={cmdText} onChange={(e) => setCmdText(e.target.value)} className="mono" placeholder="z. B. nginx -g 'daemon off;'" />
            <div className="help" style={{ marginTop: 4 }}>Unverändert lassen = Original beibehalten. Bei Änderung wird an Leerzeichen getrennt (Argumente mit Leerzeichen werden nicht unterstützt).</div>
          </div>
        </>
      )}
      </>}
      </div>
    </Modal>
  );
}
