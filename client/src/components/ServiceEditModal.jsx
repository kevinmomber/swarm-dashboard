import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Modal, useToast } from './ui.jsx';
import TabBar from './TabBar.jsx';
import LayersView from './LayersView.jsx';
import ProcessesView from './ProcessesView.jsx';
import FileBrowser from './FileBrowser.jsx';

const RESTART = ['any', 'on-failure', 'none'];

/**
 * Edit + redeploy a swarm service. Fetches the current config and applies a
 * rolling update (image, replicas, ports, env, mounts, networks, restart,
 * command args) via POST /services/:id/edit.
 */
export default function ServiceEditModal({ service, onClose, onDone }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const [image, setImage] = useState('');
  const [replicas, setReplicas] = useState('');
  const [restartCondition, setRestartCondition] = useState('any');
  const [ports, setPorts] = useState([]);
  const [envText, setEnvText] = useState('');
  const [argsText, setArgsText] = useState('');
  const [origArgs, setOrigArgs] = useState('');
  const [mounts, setMounts] = useState([]);
  const [networks, setNetworks] = useState([]);
  const [availableNetworks, setAvailableNetworks] = useState([]);
  const [cpuLimit, setCpuLimit] = useState('');
  const [memLimit, setMemLimit] = useState('');
  const [cpuRes, setCpuRes] = useState('');
  const [memRes, setMemRes] = useState('');
  const [tab, setTab] = useState('general');
  const [runtime, setRuntime] = useState(null); // { containerId, nodeId, image }

  useEffect(() => {
    let alive = true;
    api.get(`/services/${service.id}/runtime`).then((r) => alive && setRuntime(r)).catch(() => alive && setRuntime(false));
    return () => { alive = false; };
  }, [service]);

  useEffect(() => {
    let alive = true;
    api.get(`/services/${service.id}/config`)
      .then((c) => {
        if (!alive) return;
        setCfg(c);
        setImage(c.image || '');
        setReplicas(c.replicas == null ? '' : String(c.replicas));
        setRestartCondition(c.restartCondition || 'any');
        setPorts((c.ports || []).map((p) => ({ published: p.published ?? '', target: p.target ?? '', protocol: p.protocol || 'tcp', mode: p.mode || 'ingress' })));
        setEnvText((c.env || []).join('\n'));
        setArgsText((c.args || []).join(' '));
        setOrigArgs((c.args || []).join(' '));
        setMounts((c.mounts || []).map((m) => ({ type: m.type || 'volume', source: m.source || '', target: m.target || '', readOnly: !!m.readOnly })));
        setNetworks(c.networks || []);
        setAvailableNetworks(c.availableNetworks || []);
        setCpuLimit(c.cpuLimit === '' || c.cpuLimit == null ? '' : String(c.cpuLimit));
        setMemLimit(c.memLimit === '' || c.memLimit == null ? '' : String(c.memLimit));
        setCpuRes(c.cpuReservation === '' || c.cpuReservation == null ? '' : String(c.cpuReservation));
        setMemRes(c.memReservation === '' || c.memReservation == null ? '' : String(c.memReservation));
      })
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [service]);

  const setPort = (i, key, val) => setPorts((ps) => ps.map((p, idx) => (idx === i ? { ...p, [key]: val } : p)));
  const addPort = () => setPorts((ps) => [...ps, { published: '', target: '', protocol: 'tcp', mode: 'ingress' }]);
  const removePort = (i) => setPorts((ps) => ps.filter((_, idx) => idx !== i));
  const setMount = (i, key, val) => setMounts((ms) => ms.map((m, idx) => (idx === i ? { ...m, [key]: val } : m)));
  const addMount = () => setMounts((ms) => [...ms, { type: 'volume', source: '', target: '', readOnly: false }]);
  const removeMount = (i) => setMounts((ms) => ms.filter((_, idx) => idx !== i));
  const toggleNet = (name) => setNetworks((ns) => (ns.includes(name) ? ns.filter((n) => n !== name) : [...ns, name]));

  const save = async () => {
    const patch = {
      image: image.trim(),
      restartCondition,
      env: envText.split('\n').map((l) => l.trim()).filter(Boolean),
      ports: ports
        .filter((p) => String(p.target).trim())
        .map((p) => ({ published: String(p.published).trim(), target: String(p.target).trim(), protocol: p.protocol || 'tcp', mode: p.mode || 'ingress' })),
      mounts: mounts
        .filter((m) => m.source.trim() && m.target.trim())
        .map((m) => ({ type: m.type, source: m.source.trim(), target: m.target.trim(), readOnly: !!m.readOnly })),
      networks,
      cpuLimit: cpuLimit.trim(),
      memLimit: memLimit.trim(),
      cpuReservation: cpuRes.trim(),
      memReservation: memRes.trim(),
    };
    if (cfg?.mode === 'replicated' && replicas !== '') patch.replicas = replicas;
    const argsTrim = argsText.trim();
    if (argsText !== origArgs) patch.args = argsTrim ? argsTrim.split(/\s+/) : [];
    setBusy(true);
    try {
      await api.post(`/services/${service.id}/edit`, { patch });
      toast(`Service „${service.name}" wird neu deployt (Rolling Update)`, 'ok');
      onDone?.();
      onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal
      wide
      title={`Bearbeiten & Redeploy · ${service.name}`}
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
          { k: 'layers', label: 'Layer', disabled: !runtime },
          { k: 'proc', label: 'Prozesse', disabled: !runtime },
          { k: 'files', label: 'Dateien', disabled: !runtime },
        ]}
      />
      <div className="edit-tabpanel">
      {runtime === false && tab !== 'general' && <div className="banner">Kein laufender Task-Container gefunden.</div>}
      {tab === 'layers' && runtime && <LayersView nodeId={runtime.nodeId} image={runtime.image} />}
      {tab === 'proc' && runtime && <ProcessesView nodeId={runtime.nodeId} containerId={runtime.containerId} />}
      {tab === 'files' && runtime && <FileBrowser nodeId={runtime.nodeId} containerId={runtime.containerId} />}
      {tab === 'general' && <>
      {err && <div className="banner">{err}</div>}
      {!cfg && !err && <div className="help">Lade Konfiguration…</div>}
      {cfg && (
        <>
          <div className="help" style={{ marginBottom: 10 }}>
            Änderungen werden als rollierendes Swarm-Update angewendet (kein Downtime-Stop). Volumes bleiben erhalten.
          </div>
          <div className="field">
            <label>Image</label>
            <input value={image} onChange={(e) => setImage(e.target.value)} placeholder="repo/image:tag" />
          </div>
          {cfg.mode === 'replicated' && (
            <div className="field">
              <label>Repliken</label>
              <input type="number" min="0" value={replicas} onChange={(e) => setReplicas(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Restart-Bedingung</label>
            <select value={restartCondition} onChange={(e) => setRestartCondition(e.target.value)}>
              {RESTART.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Ports (veröffentlicht → Ziel)</label>
            {ports.map((p, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <input style={{ width: 90 }} value={p.published} onChange={(e) => setPort(i, 'published', e.target.value)} placeholder="Extern" />
                <span>→</span>
                <input style={{ width: 90 }} value={p.target} onChange={(e) => setPort(i, 'target', e.target.value)} placeholder="Ziel" />
                <select style={{ width: 72 }} value={p.protocol} onChange={(e) => setPort(i, 'protocol', e.target.value)}>
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </select>
                <select style={{ width: 96 }} value={p.mode} onChange={(e) => setPort(i, 'mode', e.target.value)}>
                  <option value="ingress">ingress</option>
                  <option value="host">host</option>
                </select>
                <button className="btn sm danger" onClick={() => removePort(i)}>✕</button>
              </div>
            ))}
            <button className="btn sm" onClick={addPort}>+ Port</button>
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
              <div className="help">Keine Overlay-Netzwerke gefunden.</div>
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
          </div>
          <div className="field">
            <label>Ressourcen-Limits & Reservierungen</label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div><div className="help">CPU-Limit (Kerne)</div><input style={{ width: 120 }} value={cpuLimit} onChange={(e) => setCpuLimit(e.target.value)} placeholder="z. B. 0.5" /></div>
              <div><div className="help">RAM-Limit (MB)</div><input style={{ width: 120 }} value={memLimit} onChange={(e) => setMemLimit(e.target.value)} placeholder="z. B. 512" /></div>
              <div><div className="help">CPU-Reservierung</div><input style={{ width: 120 }} value={cpuRes} onChange={(e) => setCpuRes(e.target.value)} placeholder="z. B. 0.25" /></div>
              <div><div className="help">RAM-Reservierung (MB)</div><input style={{ width: 140 }} value={memRes} onChange={(e) => setMemRes(e.target.value)} placeholder="z. B. 256" /></div>
            </div>
            <div className="help" style={{ marginTop: 4 }}>Leer lassen = kein Limit/keine Reservierung. Limit = harte Obergrenze, Reservierung = garantierte Mindestkapazität für die Platzierung.</div>
          </div>
          <div className="field">
            <label>Command / Args (optional)</label>
            <input value={argsText} onChange={(e) => setArgsText(e.target.value)} className="mono" placeholder="z. B. --flag wert" />
            <div className="help" style={{ marginTop: 4 }}>Unverändert lassen = Original beibehalten. Bei Änderung wird an Leerzeichen getrennt.</div>
          </div>
        </>
      )}
      </>}
      </div>
    </Modal>
  );
}
