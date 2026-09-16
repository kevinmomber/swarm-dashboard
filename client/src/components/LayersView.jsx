import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { bytes } from './ui.jsx';

const COLORS = ['#22d3ee', '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6'];

function instrOf(createdBy, comment) {
  const c = createdBy || '';
  const nop = c.match(/#\(nop\)\s+([A-Z]+)/);
  if (nop) return nop[1];
  const kw = c.match(/(?:^|\s)(RUN|COPY|ADD|CMD|ENV|LABEL|EXPOSE|WORKDIR|ENTRYPOINT|USER|VOLUME|ARG|HEALTHCHECK)(?:\s|$)/);
  if (kw) return kw[1];
  if (!c.trim() && comment) return '#';
  return c.trim() ? 'RUN' : '#';
}

export default function LayersView({ nodeId, image }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(() => new Set());

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null);
    api.get(`/containers/image-history?nodeId=${encodeURIComponent(nodeId || '')}&ref=${encodeURIComponent(image || '')}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [nodeId, image]);

  if (err) return <div className="banner">{err}</div>;
  if (!data) return <div className="help">Lade Layer…</div>;

  const toggle = (i) => setOpen((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div>Total layers: <b style={{ color: 'var(--accent, #58a6ff)' }}>{data.totalLayers}</b></div>
          <div>Total size: <b style={{ color: 'var(--accent, #58a6ff)' }}>{bytes(data.totalSize)}</b></div>
        </div>
        {data.id && <span className="mono" style={{ color: 'var(--text-dim)' }}>{data.id}</span>}
      </div>
      <div className="help" style={{ marginBottom: 8 }}>▤ Layer-Stack (oben = neueste) — zum Aufklappen klicken</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {data.layers.map((l, i) => {
          const num = data.totalLayers - i;
          const instr = instrOf(l.createdBy, l.comment);
          const color = COLORS[num % COLORS.length];
          const isOpen = open.has(i);
          return (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              <div onClick={() => toggle(i)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: 'pointer', background: 'var(--bg-elev2)' }}>
                <span style={{ color: 'var(--text-dim)', width: 14 }}>{isOpen ? '⌄' : '›'}</span>
                <span className="mono" style={{ color: 'var(--text-dim)', minWidth: 34 }}>#{num}</span>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', background: color, color: '#0b1220', fontWeight: 700, fontSize: 12, padding: '2px 8px', borderRadius: 4 }}>
                  {bytes(l.size)} <span>{instr}</span>
                </span>
                <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 12 }}>{bytes(l.size)}</span>
                <span className="badge muted">Normal</span>
              </div>
              {isOpen && (
                <div style={{ padding: '10px 12px', display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 40 }}>
                    <div><div className="help">Erstellt</div><div>{l.created ? new Date(l.created * 1000).toLocaleString() : '–'}</div></div>
                    <div><div className="help">Größe</div><div>{bytes(l.size)}</div></div>
                  </div>
                  <div>
                    <div className="help">Command</div>
                    <pre className="mono" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-elev2)', padding: 8, borderRadius: 6, fontSize: 12 }}>{l.createdBy || '–'}</pre>
                  </div>
                  {l.comment && <div><div className="help">Kommentar</div><div>{l.comment}</div></div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
