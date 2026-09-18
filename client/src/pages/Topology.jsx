import { useMemo } from 'react';
import { useApi } from '../components/useApi.js';
import { Badge } from '../components/ui.jsx';

const COLORS = ['#4c8dff', '#3fb950', '#d29922', '#db61a2', '#a371f7', '#f78166', '#39c5cf', '#e3b341'];

export default function Topology() {
  const { data, loading, error } = useApi('/services/topology', { poll: 10000 });

  const model = useMemo(() => {
    if (!data) return null;
    const services = [...(data.services || [])].sort((a, b) =>
      (a.stack || '~').localeCompare(b.stack || '~') || a.name.localeCompare(b.name));
    const stacks = [...new Set(services.map((s) => s.stack || '(ohne Stack)'))];
    const networks = data.networks || [];
    const rowH = 40, padTop = 20;
    const H = Math.max(services.length, networks.length, 1) * rowH + padTop * 2;
    const colStack = 30, colSvc = 340, colNet = 700, boxW = 200;

    const svcY = new Map();
    services.forEach((s, i) => svcY.set(s.id, padTop + i * rowH + 14));
    const stackColor = new Map(stacks.map((s, i) => [s, COLORS[i % COLORS.length]]));
    // stack box y = mean of its services
    const stackY = new Map();
    for (const st of stacks) {
      const ys = services.filter((s) => (s.stack || '(ohne Stack)') === st).map((s) => svcY.get(s.id));
      stackY.set(st, ys.reduce((a, b) => a + b, 0) / ys.length);
    }
    const netStep = networks.length ? (H - padTop * 2) / networks.length : 0;
    const netY = new Map(networks.map((n, i) => [n, padTop + i * netStep + 14]));

    return { services, stacks, networks, H, rowH, colStack, colSvc, colNet, boxW, svcY, stackY, netY, stackColor };
  }, [data]);

  if (loading && !data) return <><Head /><div className="spinner">Lade Topologie…</div></>;
  if (error) return <><Head /><div className="banner">{error}</div></>;
  if (!model) return <><Head /><div className="empty">Keine Daten.</div></>;

  const { services, stacks, networks, H, colStack, colSvc, colNet, boxW, svcY, stackY, netY, stackColor } = model;
  const W = colNet + boxW + 30;
  const curve = (x1, y1, x2, y2) => `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;

  return (
    <>
      <Head />
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <svg width={W} height={H} style={{ minWidth: W }}>
            {/* stack -> service links */}
            {services.map((s) => {
              const st = s.stack || '(ohne Stack)';
              return (
                <path key={`ss-${s.id}`} d={curve(colStack + boxW, stackY.get(st), colSvc, svcY.get(s.id))}
                  fill="none" stroke={stackColor.get(st)} strokeOpacity="0.35" strokeWidth="1.5" />
              );
            })}
            {/* service -> network links */}
            {services.flatMap((s) => (s.networks || []).map((n) => (
              netY.has(n) ? <path key={`sn-${s.id}-${n}`} d={curve(colSvc + boxW, svcY.get(s.id), colNet, netY.get(n))}
                fill="none" stroke="var(--border)" strokeWidth="1" /> : null
            )))}

            {/* stack boxes */}
            {stacks.map((st) => (
              <g key={`stk-${st}`}>
                <rect x={colStack} y={stackY.get(st) - 13} width={boxW} height={26} rx={6}
                  fill="var(--bg-elev2)" stroke={stackColor.get(st)} strokeWidth="1.5" />
                <text x={colStack + 10} y={stackY.get(st) + 4} fill="var(--text)" fontSize="12" fontWeight="700">📦 {st}</text>
              </g>
            ))}
            {/* service boxes */}
            {services.map((s) => (
              <g key={`svc-${s.id}`}>
                <rect x={colSvc} y={svcY.get(s.id) - 13} width={boxW} height={26} rx={6}
                  fill="var(--bg-elev2)" stroke="var(--border)" strokeWidth="1" />
                <text x={colSvc + 8} y={svcY.get(s.id) + 4} fill="var(--text)" fontSize="11">
                  {(s.stack ? s.name.replace(s.stack + '_', '') : s.name).slice(0, 22)}
                  <tspan fill="var(--text-dim)"> {s.desired === 'global' ? 'glob' : `${s.running}/${s.desired ?? '?'}`}</tspan>
                </text>
              </g>
            ))}
            {/* network boxes */}
            {networks.map((n) => (
              <g key={`net-${n}`}>
                <rect x={colNet} y={netY.get(n) - 13} width={boxW} height={26} rx={6}
                  fill="var(--bg-elev2)" stroke="#39c5cf" strokeWidth="1.2" />
                <text x={colNet + 10} y={netY.get(n) + 4} fill="var(--text)" fontSize="11">🔗 {n.slice(0, 24)}</text>
              </g>
            ))}
          </svg>
        </div>
        <div className="help" style={{ marginTop: 8 }}>
          <Badge kind="muted">📦 Stack</Badge> → <Badge kind="muted">Service (läuft/soll)</Badge> → <Badge kind="info">🔗 Netzwerk</Badge>
        </div>
      </div>
    </>
  );
}

function Head() {
  return (
    <div className="page-head">
      <div><h1>Topologie</h1><div className="sub">Beziehungen zwischen Stacks, Services und Netzwerken</div></div>
    </div>
  );
}
