import { useEffect, useState } from 'react';
import { api, postSSE } from '../api.js';
import { Modal, Badge, bytes, useToast } from './ui.jsx';

const PHASE_LABEL = {
  volumes: 'Kopiere Volume-Daten…',
  reschedule: 'Verschiebe Service auf Ziel-Node…',
  done: 'Fertig',
};

/**
 * vMotion-style service migration: copies the service's named-volume data to a
 * target node, then pins the service there so it reschedules onto the migrated
 * volumes. Source volumes remain intact.
 */
export default function MigrateModal({ service, onClose, onDone }) {
  const toast = useToast();
  const [nodes, setNodes] = useState([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(null);
  const [curVol, setCurVol] = useState(null);
  const [prog, setProg] = useState(null); // { total, bytes }

  useEffect(() => {
    api.get('/nodes').then((ns) => {
      const ready = (ns || []).filter((n) => n.state === 'ready');
      setNodes(ready);
      // preselect a node other than where it currently runs
      const other = ready.find((n) => !n.connected) || ready[0];
      if (other) setTarget(other.hostname);
    }).catch(() => {});
  }, []);

  const migrate = async () => {
    if (!target) return;
    setBusy(true); setPhase('start'); setProg(null); setCurVol(null);
    let errMsg = null;
    try {
      await postSSE(`/services/${service.id}/migrate`, { targetNode: target }, (evt) => {
        if (evt.type === 'phase') setPhase(evt.phase);
        else if (evt.type === 'volume') { setCurVol(evt.volume); setProg({ total: null, bytes: 0 }); }
        else if (evt.type === 'size') setProg((p) => ({ ...(p || { bytes: 0 }), total: evt.total || null }));
        else if (evt.type === 'progress') setProg((p) => ({ ...(p || { total: null }), bytes: evt.bytes }));
        else if (evt.type === 'error') errMsg = evt.message;
        else if (evt.type === 'done') setPhase('done');
      });
      if (errMsg) throw new Error(errMsg);
      toast(`„${service.name}" wird auf ${target} migriert`);
      onDone?.(); onClose();
    } catch (e) { toast(e.message, 'err'); setPhase(null); } finally { setBusy(false); }
  };

  const pct = prog
    ? (prog.total ? Math.min(99, Math.round((prog.bytes / prog.total) * 100))
      : Math.min(95, Math.round((1 - 1 / (1 + prog.bytes / (10 * 1024 * 1024))) * 100)))
    : 0;

  return (
    <Modal title={`Migration · ${service.name}`} onClose={busy ? undefined : onClose}
      footer={<>
        <button className="btn" disabled={busy} onClick={onClose}>Abbrechen</button>
        <button className="btn primary" disabled={busy || !target} onClick={migrate}>Migrieren</button>
      </>}>
      <div className="help" style={{ marginBottom: 10 }}>
        Verschiebt den Service samt seiner benannten Volumes auf einen anderen Node (vMotion-Prinzip):
        die Volume-Daten werden auf den Ziel-Node kopiert, danach wird der Service dorthin verlagert.
        Quell-Volumes bleiben erhalten. Bind-Mounts (Host-Pfade) werden nicht kopiert.
      </div>
      <div className="field">
        <label>Ziel-Node</label>
        <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
          {nodes.length === 0 && <option value="">– keine Nodes –</option>}
          {nodes.map((n) => (
            <option key={n.id} value={n.hostname}>
              {n.hostname}{n.connected ? ' (aktuell verbunden)' : ''}{n.role === 'manager' ? ' · Manager' : ''}
            </option>
          ))}
        </select>
      </div>
      {phase && (
        <div style={{ marginTop: 12 }}>
          <div className="help" style={{ marginBottom: 4 }}>
            <Badge kind={phase === 'done' ? 'ok' : 'info'}>{PHASE_LABEL[phase] || phase}</Badge>
            {curVol && phase === 'volumes' && <span style={{ marginLeft: 8 }} className="mono">{curVol}</span>}
          </div>
          {prog && phase === 'volumes' && (
            <>
              <div className="help" style={{ marginBottom: 4 }}>{bytes(prog.bytes || 0)}{prog.total ? ` / ~${bytes(prog.total)}` : ''} ({pct}%)</div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-elev2)', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .25s' }} />
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
