import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../components/useApi.js';
import { Badge, Modal, stateKind, bytes, short, useToast, Copy, usePersistentState } from '../components/ui.jsx';
import EndpointManageModal from '../components/EndpointManageModal.jsx';

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

const typeBadge = (t) => {
  if (t === 'swarm') return <Badge kind="info">Swarm</Badge>;
  if (t === 'swarm-worker') return <Badge kind="muted">Swarm-Worker</Badge>;
  if (t === 'standalone') return <Badge kind="ok">Standalone</Badge>;
  return <Badge kind="muted">{t || '?'}</Badge>;
};

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
  const { data: inv, reload: reloadInv } = useApi('/endpoints/inventory', { poll: 10000 });
  const toast = useToast();
  const [removeTarget, setRemoveTarget] = useState(null);
  const [confirmChk, setConfirmChk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [groupBy, setGroupBy] = usePersistentState('nodes.groupBy', 'endpoint'); // 'endpoint' | 'tag'
  const [manageEp, setManageEp] = useState(null);

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

  const refreshAll = () => { reload(); reloadInv(); };

  const epStats = useMemo(() => {
    const eps = inv || [];
    return {
      total: eps.length,
      reachable: eps.filter((e) => e.reachable).length,
      unreachable: eps.filter((e) => !e.reachable),
    };
  }, [inv]);

  const connected = (data || []).find((n) => n.connected);
  const anyAgent = (data || []).some((n) => n.live?.source === 'agent');
  const m = connected?.live || (metrics && !metrics.error ? metrics : null);

  // Rich local metrics keyed by node id (agent/probe live data + actions).
  const localById = useMemo(() => {
    const map = new Map();
    for (const n of data || []) map.set(n.id, n);
    return map;
  }, [data]);

  // Build the grouped structure from the aggregated inventory.
  const groups = useMemo(() => {
    const eps = inv || [];
    if (groupBy === 'tag') {
      const byTag = new Map();
      const add = (tag, ep) => {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(ep);
      };
      for (const ep of eps) {
        const tags = ep.tags && ep.tags.length ? ep.tags : ['Ohne Tag'];
        for (const t of tags) add(t, ep);
      }
      return [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, endpoints]) => ({ key, label: key, endpoints }));
    }
    // group-by endpoint: one group per endpoint
    return eps.map((ep) => ({ key: ep.id, label: ep.name, endpoints: [ep] }));
  }, [inv, groupBy]);

  const NodeRow = ({ ep, n }) => {
    const local = ep.id === 'local' ? localById.get(n.id) : null;
    const canAct = ep.id === 'local' && !ep.readOnly && n.role !== 'standalone';
    return (
      <tr>
        <td>
          <div style={{ fontWeight: 600 }}>
            {n.hostname} {local?.connected && <Badge kind="info">verbunden</Badge>}
            {local?.live?.source === 'agent' && <Badge kind="ok">agent{local.agentVersion ? ` v${local.agentVersion}` : ''}</Badge>}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{short(n.id)}<Copy text={n.id} />{n.addr ? ` · ${n.addr}` : ''}</div>
        </td>
        <td>{n.role === 'manager'
          ? <Badge kind={n.leader ? 'info' : 'muted'}>{n.leader ? 'Leader' : 'Manager'}</Badge>
          : n.role === 'standalone' ? <Badge kind="ok">Host</Badge> : <Badge kind="muted">Worker</Badge>}</td>
        <td><Badge kind={stateKind(n.state)}>{n.state}</Badge></td>
        <td><Badge kind={stateKind(n.availability)}>{n.availability}</Badge></td>
        <td>{local ? <CpuCell n={local} /> : <span className="help mono" style={{ fontSize: 11 }}>{n.ncpu ? `${n.ncpu} CPU` : '–'}</span>}</td>
        <td>{local ? <RamCell n={local} /> : <span className="help mono" style={{ fontSize: 11 }}>{n.memTotal ? bytes(n.memTotal) : '–'}</span>}</td>
        <td>{local ? <DiskCell n={local} /> : <span className="help mono" style={{ fontSize: 11 }}>{n.engine ? `v${n.engine}` : '–'}</span>}</td>
        <td>
          {canAct ? (
            <div className="actions">
              <button className="btn sm" disabled={n.availability === 'active'} onClick={() => setAvailability(n.id, 'active')}>Aktivieren</button>
              <button className="btn sm" disabled={n.availability === 'pause'} onClick={() => setAvailability(n.id, 'pause')}>Pause</button>
              <button className="btn sm" disabled={n.availability === 'drain'} onClick={() => setAvailability(n.id, 'drain')}>Drain</button>
              <button className="btn sm danger" disabled={local?.connected} title={local?.connected ? 'Verbundener Node' : ''} onClick={() => { setRemoveTarget(n); setConfirmChk(false); }}>Entfernen</button>
            </div>
          ) : <span className="help">{ep.readOnly ? 'read-only' : n.role === 'standalone' ? 'Host' : '—'}</span>}
        </td>
      </tr>
    );
  };

  const EndpointBlock = ({ ep }) => (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{ep.name}</span>
        {ep.builtin && <Badge kind="muted">lokal</Badge>}
        {typeBadge(ep.type)}
        {ep.reachable
          ? <Badge kind="ok">erreichbar</Badge>
          : <Badge kind="err">nicht erreichbar</Badge>}
        {ep.readOnly && <Badge kind="warn">read-only</Badge>}
        {(ep.tags || []).map((t) => <Badge key={t} kind="info">{t}</Badge>)}
        <span className="help" style={{ marginLeft: 'auto' }}>
          {ep.reachable ? `${ep.nodes?.length || 0} Node(s) · Docker ${ep.dockerVersion || '?'}` : (ep.error || 'Verbindung fehlgeschlagen')}
        </span>
        {ep.reachable && <button className="btn sm" onClick={() => setManageEp(ep)}>Verwalten</button>}
      </div>
      {ep.reachable && (ep.containers != null) && (
        <div className="help" style={{ marginBottom: 6 }}>
          {ep.containersRunning ?? 0}/{ep.containers} Container laufend · {ep.images ?? '?'} Images
          {ep.ncpu ? ` · ${ep.ncpu} CPU` : ''}{ep.memTotal ? ` · ${bytes(ep.memTotal)} RAM` : ''}
        </div>
      )}
      {ep.reachable && ep.nodes?.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>Hostname</th><th>Rolle</th><th>Status</th><th>Verfügbarkeit</th><th>CPU</th><th>RAM</th><th>Disk/Engine</th><th>Aktionen</th>
            </tr></thead>
            <tbody>{ep.nodes.map((n) => <NodeRow key={`${ep.id}/${n.id}`} ep={ep} n={n} />)}</tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div><h1>Nodes</h1><div className="sub">Knoten & Hosts über alle Docker-Endpoints</div></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Link className="btn" to="/settings">＋ Endpoints verwalten</Link>
          <button className="btn" onClick={refreshAll}>↻ Aktualisieren</button>
        </div>
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

      <div className="toolbar" style={{ marginBottom: 12 }}>
        <label style={{ margin: 0 }}>Gruppieren nach:</label>
        <select style={{ width: 160 }} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
          <option value="endpoint">Endpoint (Zugehörigkeit)</option>
          <option value="tag">Tag</option>
        </select>
        {inv && (
          <span className="help" style={{ marginLeft: 'auto' }}>
            <Badge kind={epStats.reachable === epStats.total ? 'ok' : 'warn'}>{epStats.reachable}/{epStats.total} Endpoints erreichbar</Badge>
          </span>
        )}
      </div>

      {epStats.unreachable.length > 0 && (
        <div className="banner" style={{ marginBottom: 12 }}>
          ⚠ Nicht erreichbar: {epStats.unreachable.map((e) => e.name).join(', ')}
        </div>
      )}

      {error && <div className="banner">{error}</div>}
      {loading && !data && !inv && <div className="spinner">Lade Nodes…</div>}

      {groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 8 }}>
          {groupBy === 'tag' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 2px 8px' }}>
              <Badge kind="info">{g.label}</Badge>
              <span className="help">{g.endpoints.length} Endpoint(s)</span>
            </div>
          )}
          {g.endpoints.map((ep) => <EndpointBlock key={`${g.key}/${ep.id}`} ep={ep} />)}
        </div>
      ))}

      <div className="help" style={{ marginTop: 12 }}>
        {anyAgent
          ? 'CPU/RAM/Disk zeigen die echte Live-Auslastung je Node (via Node-Agent). Ohne Agent zeigt die CPU/RAM-Spalte die reservierte Kapazität. Remote-Endpoints werden aktuell read-only angezeigt (Schreibaktionen folgen in Phase 2).'
          : 'CPU/RAM zeigen aktuell die durch Task-Reservierungen belegte Kapazität. Remote-Endpoints werden read-only angezeigt (Schreibaktionen folgen in Phase 2). Für echte Live-Werte je Node den Node-Agenten deployen.'}
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
      {manageEp && <EndpointManageModal endpoint={manageEp} onClose={() => setManageEp(null)} />}
    </>
  );
}
