import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Badge, stateKind, short, ago, bytes } from './ui.jsx';

/** Compact inline usage bar (mirrors the Nodes view style). */
function Bar({ pct, caption }) {
  const p = pct == null ? null : Math.max(0, Math.min(100, pct));
  const color = p == null ? 'var(--border)' : p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--amber)' : 'var(--accent)';
  return (
    <div style={{ minWidth: 90 }}>
      <div style={{ height: 6, borderRadius: 4, background: 'var(--bg-elev2)', overflow: 'hidden' }}>
        <div style={{ width: `${p ?? 0}%`, height: '100%', background: color }} />
      </div>
      <div className="help" style={{ marginTop: 3 }}>{caption ?? (p == null ? '–' : `${p}%`)}</div>
    </div>
  );
}

function CpuCell({ stats }) {
  if (!stats || stats.cpuPct == null) return <span style={{ color: 'var(--text-dim)' }}>–</span>;
  return <Bar pct={stats.cpuPct} caption={`${stats.cpuPct}%`} />;
}
function RamCell({ stats }) {
  if (!stats || stats.memBytes == null) return <span style={{ color: 'var(--text-dim)' }}>–</span>;
  const cap = stats.memLimit ? `${bytes(stats.memBytes)} / ${bytes(stats.memLimit)}` : bytes(stats.memBytes);
  return <Bar pct={stats.memPct} caption={cap} />;
}

export default function PlacementModal({ service, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    const load = () => api.get(`/services/${service.id}/placement`).then((d) => { if (live) setData(d); }).catch((e) => live && setErr(e.message));
    load();
    const id = setInterval(load, 5000);
    return () => { live = false; clearInterval(id); };
  }, [service.id]);

  const nodes = data ? [...new Set(data.tasks.map((t) => t.node.hostname))] : [];
  const volumes = data?.volumes || [];

  return (
    <Modal title={`Platzierung · ${service.name}`} onClose={onClose} wide
      footer={<button className="btn" onClick={onClose}>Schließen</button>}>
      {err && <div className="banner">{err}</div>}
      {!data && !err && <div className="help">Lade Platzierung…</div>}
      {data && data.tasks.length === 0 && <div className="empty" style={{ padding: 20 }}>Aktuell keine laufenden Tasks.</div>}
      {data && data.tasks.length > 0 && (
        <>
          <div className="help" style={{ marginBottom: 10 }}>
            {data.tasks.length} laufende(r) Task(s) auf {nodes.length} Node(s). Live-Werte, Aktualisierung alle 5&nbsp;s.
          </div>
          <table>
            <thead><tr><th>Node</th><th>Rolle</th><th>Slot</th><th>CPU</th><th>RAM</th><th>Status</th><th>Seit</th></tr></thead>
            <tbody>
              {data.tasks.map((t) => (
                <tr key={t.taskId}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{t.node.hostname}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{short(t.taskId)}</div>
                  </td>
                  <td>
                    {t.node.role === 'manager'
                      ? <Badge kind={t.node.leader ? 'info' : 'muted'}>{t.node.leader ? 'Manager (Leader)' : 'Manager'}</Badge>
                      : <Badge kind="muted">Worker</Badge>}
                  </td>
                  <td>{t.slot ?? '–'}</td>
                  <td><CpuCell stats={t.stats} /></td>
                  <td><RamCell stats={t.stats} /></td>
                  <td><Badge kind={stateKind(t.state)}>{t.state}</Badge></td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t.timestamp ? ago(t.timestamp) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {volumes.length > 0 && (
            <>
              <div className="help" style={{ margin: '14px 0 6px' }}>Volumes</div>
              <table>
                <thead><tr><th>Volume</th><th>Mount</th><th>Größe</th></tr></thead>
                <tbody>
                  {volumes.map((v) => (
                    <tr key={v.name}>
                      <td className="mono" style={{ fontSize: 12 }}>{v.name}</td>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>{v.target || '–'}</td>
                      <td>{v.bytes == null ? <span style={{ color: 'var(--text-dim)' }}>–</span> : bytes(v.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
