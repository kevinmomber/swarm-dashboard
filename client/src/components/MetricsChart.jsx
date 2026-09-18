import { useMemo, useState } from 'react';
import { useApi } from './useApi.js';

const COLORS = ['#4c8dff', '#3fb950', '#d29922', '#db61a2', '#a371f7', '#f78166'];

/** Minimal dependency-free SVG line chart (0-100% axis). */
function Chart({ title, series, unit = '%' }) {
  const W = 520, H = 140, PAD = 24;
  const allPts = series.flatMap((s) => s.points);
  if (allPts.length === 0) return <div className="help">Noch keine Daten – der Verlauf füllt sich mit der Zeit.</div>;
  const tMin = Math.min(...allPts.map((p) => p.t));
  const tMax = Math.max(...allPts.map((p) => p.t));
  const span = Math.max(1, tMax - tMin);
  const x = (t) => PAD + ((t - tMin) / span) * (W - 2 * PAD);
  const y = (v) => H - PAD - (Math.max(0, Math.min(100, v ?? 0)) / 100) * (H - 2 * PAD);
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="help" style={{ marginBottom: 4 }}>{title}</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: 'var(--bg-elev2)', borderRadius: 8 }}>
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={PAD} x2={W - PAD} y1={y(g)} y2={y(g)} stroke="var(--border)" strokeWidth="0.5" />
            <text x={2} y={y(g) + 3} fill="var(--text-dim)" fontSize="9">{g}</text>
          </g>
        ))}
        {series.map((s, i) => {
          const pts = s.points.filter((p) => p.v != null);
          if (pts.length === 0) return null;
          const dpath = pts.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
          return <path key={s.node} d={dpath} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="1.5" />;
        })}
      </svg>
      <div className="pill-group" style={{ marginTop: 4 }}>
        {series.map((s, i) => (
          <span key={s.node} className="help" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 8 }}>
            <span style={{ width: 10, height: 3, background: COLORS[i % COLORS.length], display: 'inline-block' }} />
            {s.node}{s.last != null ? ` (${s.last}${unit})` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function MetricsChart() {
  const [hours, setHours] = useState(6);
  const { data, loading } = useApi(`/nodes/history?hours=${hours}`, { poll: 60000 });

  const { cpu, mem } = useMemo(() => {
    const nodes = data?.nodes || [];
    const build = (key) => nodes.map((n) => ({
      node: n.node,
      points: n.points.map((p) => ({ t: p.t, v: p[key] })),
      last: [...n.points].reverse().find((p) => p[key] != null)?.[key] ?? null,
    }));
    return { cpu: build('cpu'), mem: build('mem') };
  }, [data]);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Auslastungs-Verlauf</h3>
        <div className="spacer" style={{ flex: 1 }} />
        <label style={{ margin: 0 }}>Zeitraum:</label>
        <select style={{ width: 120 }} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          <option value={1}>1 Stunde</option>
          <option value={6}>6 Stunden</option>
          <option value={12}>12 Stunden</option>
          <option value={24}>24 Stunden</option>
          <option value={48}>48 Stunden</option>
        </select>
      </div>
      {loading && !data ? <div className="spinner">Lade…</div> : (
        <div className="grid cols-2">
          <Chart title="CPU-Last (%)" series={cpu} />
          <Chart title="RAM-Auslastung (%)" series={mem} />
        </div>
      )}
    </div>
  );
}
