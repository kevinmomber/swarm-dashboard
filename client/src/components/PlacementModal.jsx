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
    <Modal title={`Platzierung & Ressourcen · ${service.name}`} onClose={onClose} wide
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

      {data && (
        <>
          <div className="help" style={{ margin: '16px 0 6px' }}>Netzwerke</div>
          {(data.networks || []).length === 0 ? (
            <div className="help">Keine Netzwerke zugeordnet.</div>
          ) : (
            <table>
              <thead><tr><th>Netzwerk</th><th>Typ</th><th>Subnetz</th><th>Adresse(n)</th></tr></thead>
              <tbody>
                {data.networks.map((n) => {
                  const perTask = data.tasks
                    .map((t) => { const x = t.networks?.find((y) => y.id === n.id); return { slot: t.slot, ips: x?.addresses || [], mac: x?.mac || null }; })
                    .filter((x) => x.ips.length);
                  return (
                    <tr key={n.id}>
                      <td>
                        <span style={{ fontWeight: 600 }}>{n.name}</span>
                        {n.ingress && <> <Badge kind="info">ingress</Badge></>}
                        {n.ipv6 && <> <Badge kind="muted">IPv6</Badge></>}
                        {n.internal && <> <Badge kind="muted">internal</Badge></>}
                        {!n.configured && !n.ingress && <> <Badge kind="muted">implizit</Badge></>}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>{n.driver}{n.scope && n.scope !== '?' ? ` · ${n.scope}` : ''}</td>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>{(n.subnets || []).join(', ') || '–'}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {perTask.length === 0 ? <span style={{ color: 'var(--text-dim)' }}>–</span> : perTask.map((x) => (
                          <div key={x.slot ?? x.ips[0]}>
                            {data.tasks.length > 1 ? `#${x.slot ?? '?'} ` : ''}{x.ips.join(', ')}
                            {x.mac && ['macvlan', 'ipvlan'].includes(n.driver) && <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>MAC {x.mac}</div>}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 16 }}>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <div className="help" style={{ marginBottom: 6 }}>Configs</div>
              {(data.configs || []).length === 0 ? <div className="help">keine</div> : (
                <table>
                  <thead><tr><th>Name</th><th>Pfad im Container</th></tr></thead>
                  <tbody>
                    {data.configs.map((c) => (
                      <tr key={`${c.name}:${c.target}`}>
                        <td className="mono" style={{ fontSize: 12 }}>{c.name}</td>
                        <td className="mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>{c.target || '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <div className="help" style={{ marginBottom: 6 }}>Secrets <span style={{ opacity: 0.7 }}>(nur Name)</span></div>
              {(data.secrets || []).length === 0 ? <div className="help">keine</div> : (
                <table>
                  <thead><tr><th>Name</th></tr></thead>
                  <tbody>
                    {data.secrets.map((s) => (
                      <tr key={s.name}><td className="mono" style={{ fontSize: 12 }}>{s.name}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
