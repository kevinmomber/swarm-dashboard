import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../components/useApi.js';
import { Badge, Modal, stateKind, bytes, short, useToast, Copy } from '../components/ui.jsx';

function Bar({ pct, caption }) {
  const p = pct == null ? null : Math.max(0, Math.min(100, pct));
  const color = p == null ? 'var(--border)' : p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--amber)' : 'var(--accent)';
  return (
    <div style={{ minWidth: 96 }}>
      <div style={{ height: 6, borderRadius: 4, background: 'var(--bg-elev2)', overflow: 'hidden' }}>
        <div style={{ width: `${p ?? 0}%`, height: '100%', background: color }} />
      </div>
      <div className="help" style={{ marginTop: 3 }}>{caption ?? (p == null ? '–' : `${p}%`)}</div>
    </div>
  );
}

function MetricCard({ label, value, sub, pct }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 24 }}>{value}{sub && <small> {sub}</small>}</div>
      {pct != null && <div style={{ marginTop: 8 }}><Bar pct={pct} /></div>}
    </div>
  );
}

const pctOf = (used, total) => (total ? Math.round((used / total) * 100) : null);

// CPU cell: live load% if agent/probe present, else reserved%.
function CpuCell({ n }) {
  if (n.live) return <Bar pct={n.live.cpu.loadPct} caption={`load ${n.live.cpu.load1?.toFixed?.(2) ?? '–'}`} />;
  return <Bar pct={n.reserved.cpuPct} caption={n.reserved.cpuPct == null ? '–' : `${n.reserved.cpuPct}% res.`} />;
}
function RamCell({ n }) {
  if (n.live) {
    const p = pctOf(n.live.mem.used, n.live.mem.total);
    return <Bar pct={p} caption={`${bytes(n.live.mem.used)} / ${bytes(n.live.mem.total)}`} />;
  }
  return <Bar pct={n.reserved.memPct} caption={n.reserved.memPct == null ? '–' : `${n.reserved.memPct}% res.`} />;
}
function DiskCell({ n }) {
  if (n.live) {
    const p = pctOf(n.live.disk.used, n.live.disk.total);
    return <Bar pct={p} caption={`${bytes(n.live.disk.free)} frei`} />;
  }
  return <span className="help">–</span>;
}

export default function Nodes() {
  const { data, error, loading, reload } = useApi('/nodes', { poll: 8000 });
  const { data: metrics } = useApi('/nodes/metrics', { poll: 20000 });
  const toast = useToast();
  const [removeTarget, setRemoveTarget] = useState(null);
  const [confirmChk, setConfirmChk] = useState(false);
  const [busy, setBusy] = useState(false);

  const setAvailability = async (id, availability) => {
    try {
      await api.post(`/nodes/${id}/availability`, { availability });
      toast(`Verfügbarkeit auf "${availability}" gesetzt`); reload();
    } catch (e) { toast(e.message, 'err'); }
  };

  const removeNode = async () => {
    setBusy(true);
    try {
      await api.del(`/nodes/${removeTarget.id}`);
      toast(`Node "${removeTarget.hostname}" aus dem Swarm entfernt`);
      setRemoveTarget(null); reload();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const connected = (data || []).find((n) => n.connected);
  const anyAgent = (data || []).some((n) => n.live?.source === 'agent');
  // Prefer connected node's own live block; fall back to /metrics probe.
  const m = connected?.live || (metrics && !metrics.error ? metrics : null);

  return (
    <>
      <div className="page-head">
        <div><h1>Nodes</h1><div className="sub">Manager- und Worker-Knoten im Swarm</div></div>
        <button className="btn" onClick={reload}>↻ Aktualisieren</button>
      </div>

      {m && connected && (
        <>
          <div className="help" style={{ marginBottom: 8 }}>
            Auslastung <b>{connected.hostname}</b>{connected.live?.source === 'agent' ? ' (Agent)' : ' (Live-Probe)'}:
          </div>
          <div className="grid cols-3" style={{ marginBottom: 20 }}>
            <MetricCard label="CPU-Last" value={m.cpu.loadPct != null ? `${m.cpu.loadPct}%` : '–'}
              sub={`load ${m.cpu.load1?.toFixed?.(2) ?? '–'} · ${m.cpu.cpus} CPU`} pct={m.cpu.loadPct} />
            <MetricCard label="RAM" value={bytes(m.mem.used)} sub={`/ ${bytes(m.mem.total)}`}
              pct={pctOf(m.mem.used, m.mem.total)} />
            <MetricCard label="Freier Speicher" value={bytes(m.disk.free)} sub={`/ ${bytes(m.disk.total)}`}
              pct={pctOf(m.disk.used, m.disk.total)} />
          </div>
        </>
      )}

      {error && <div className="banner">{error}</div>}
      {loading && !data && <div className="spinner">Lade Nodes…</div>}

      {data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Hostname</th><th>Rolle</th><th>Status</th><th>Verfügbarkeit</th>
                <th>CPU</th><th>RAM</th><th>Disk</th><th>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {data.map((n) => (
                <tr key={n.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {n.hostname} {n.connected && <Badge kind="info">verbunden</Badge>}
                      {n.live?.source === 'agent' && <Badge kind="ok">agent{n.agentVersion ? ` v${n.agentVersion}` : ''}</Badge>}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{short(n.id)}<Copy text={n.id} /> · {n.addr}</div>
                  </td>
                  <td>{n.role === 'manager'
                    ? <Badge kind={n.leader ? 'info' : 'muted'}>{n.leader ? 'Leader' : 'Manager'}</Badge>
                    : <Badge kind="muted">Worker</Badge>}</td>
                  <td><Badge kind={stateKind(n.state)}>{n.state}</Badge></td>
                  <td><Badge kind={stateKind(n.availability)}>{n.availability}</Badge></td>
                  <td><CpuCell n={n} /></td>
                  <td><RamCell n={n} /></td>
                  <td><DiskCell n={n} /></td>
                  <td>
                    <div className="actions">
                      <button className="btn sm" disabled={n.availability === 'active'} onClick={() => setAvailability(n.id, 'active')}>Aktivieren</button>
                      <button className="btn sm" disabled={n.availability === 'pause'} onClick={() => setAvailability(n.id, 'pause')}>Pause</button>
                      <button className="btn sm" disabled={n.availability === 'drain'} onClick={() => setAvailability(n.id, 'drain')}>Drain</button>
                      <button className="btn sm danger" disabled={n.connected} title={n.connected ? 'Verbundener Node' : ''} onClick={() => { setRemoveTarget(n); setConfirmChk(false); }}>Entfernen</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="help" style={{ marginTop: 12 }}>
        {anyAgent
          ? 'CPU/RAM/Disk zeigen die echte Live-Auslastung je Node (via Node-Agent). Ohne Agent zeigt die CPU/RAM-Spalte die reservierte Kapazität.'
          : 'CPU/RAM zeigen aktuell die durch Task-Reservierungen belegte Kapazität. Für echte Live-Werte je Node den Node-Agenten (globaler Service swarmdash-agent) deployen — siehe README.'}
      </div>

      {removeTarget && (
        <Modal title="Node entfernen" onClose={() => setRemoveTarget(null)}
          footer={<>
            <button className="btn" onClick={() => setRemoveTarget(null)}>Abbrechen</button>
            <button className="btn danger" disabled={busy || !confirmChk} onClick={removeNode}>Node entfernen</button>
          </>}>
          <div className="banner">
            Der Node <b>{removeTarget.hostname}</b> ({removeTarget.role}) wird endgültig aus dem Swarm entfernt.
            Laufende Tasks werden neu verteilt. Ein Manager sollte zuvor gedrained/demoted sein.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={confirmChk} onChange={(e) => setConfirmChk(e.target.checked)} />
            <span>Ja, ich möchte „{removeTarget.hostname}" wirklich aus dem Swarm entfernen.</span>
          </label>
        </Modal>
      )}
    </>
  );
}
