import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

/** Static navigation targets, always searchable. */
const PAGES = [
  { label: 'Übersicht', to: '/', kind: 'Seite' },
  { label: 'Nodes', to: '/nodes', kind: 'Seite' },
  { label: 'Services', to: '/services', kind: 'Seite' },
  { label: 'Stacks', to: '/stacks', kind: 'Seite' },
  { label: 'Tasks', to: '/tasks', kind: 'Seite' },
  { label: 'Container', to: '/containers', kind: 'Seite' },
  { label: 'Images', to: '/images', kind: 'Seite' },
  { label: 'Ressourcen', to: '/resources', kind: 'Seite' },
  { label: 'Security', to: '/security', kind: 'Seite' },
  { label: 'Einstellungen', to: '/settings', kind: 'Seite' },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [data, setData] = useState({ services: [], tasks: [], volumes: [], images: [], nodes: [] });
  const inputRef = useRef(null);
  const navigate = useNavigate();

  // Global hotkey: Ctrl/Cmd-K toggles the palette.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); setOpen((v) => !v);
      } else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Load the index lazily whenever the palette opens.
  useEffect(() => {
    if (!open) return;
    setQ(''); setIdx(0);
    setTimeout(() => inputRef.current?.focus(), 20);
    Promise.allSettled([
      api.get('/services'), api.get('/tasks'), api.get('/volumes'), api.get('/images'), api.get('/nodes'),
    ]).then(([s, t, v, i, n]) => setData({
      services: s.value || [], tasks: t.value || [], volumes: v.value || [], images: i.value || [], nodes: n.value || [],
    }));
  }, [open]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    const out = [];
    for (const p of PAGES) if (!term || p.label.toLowerCase().includes(term)) out.push({ ...p });
    if (term) {
      for (const s of data.services) {
        if ((s.name || '').toLowerCase().includes(term) || (s.image || '').toLowerCase().includes(term))
          out.push({ label: s.name, sub: s.image, kind: 'Service', to: '/services' });
      }
      for (const n of data.nodes) {
        if ((n.hostname || '').toLowerCase().includes(term))
          out.push({ label: n.hostname, sub: n.role, kind: 'Node', to: '/nodes' });
      }
      for (const v of data.volumes) {
        if ((v.name || '').toLowerCase().includes(term))
          out.push({ label: v.name, sub: v.node, kind: 'Volume', to: '/resources' });
      }
      for (const im of data.images) {
        const tag = (im.repoTags && im.repoTags[0]) || im.id;
        if ((tag || '').toLowerCase().includes(term))
          out.push({ label: tag, sub: im.node, kind: 'Image', to: '/images' });
      }
      for (const t of data.tasks) {
        if ((t.image || '').toLowerCase().includes(term) || (t.node || '').toLowerCase().includes(term))
          out.push({ label: `${t.image}`, sub: `${t.node} · ${t.state}`, kind: 'Task', to: '/tasks' });
      }
    }
    return out.slice(0, 40);
  }, [q, data]);

  useEffect(() => { if (idx >= results.length) setIdx(0); }, [results, idx]);

  if (!open) return null;

  const go = (r) => { if (r?.to) { navigate(r.to); setOpen(false); } };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[idx]); }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
      style={{ alignItems: 'flex-start', paddingTop: '12vh' }}>
      <div className="modal" style={{ width: 620, maxWidth: '92vw' }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
          <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKeyDown}
            placeholder="🔍 Suchen: Seiten, Services, Nodes, Volumes, Images, Tasks…"
            style={{ width: '100%', fontSize: 15 }} />
        </div>
        <div style={{ maxHeight: '52vh', overflow: 'auto' }}>
          {results.length === 0 && <div className="help" style={{ padding: 16 }}>Keine Treffer.</div>}
          {results.map((r, i) => (
            <div key={i} onMouseEnter={() => setIdx(i)} onClick={() => go(r)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', cursor: 'pointer',
                background: i === idx ? 'var(--bg-elev2)' : 'transparent' }}>
              <span className="badge muted" style={{ minWidth: 64, justifyContent: 'center' }}>{r.kind}</span>
              <span style={{ fontWeight: 600 }}>{r.label}</span>
              {r.sub && <span className="help mono" style={{ marginLeft: 'auto', fontSize: 12 }}>{r.sub}</span>}
            </div>
          ))}
        </div>
        <div className="help" style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', display: 'flex', gap: 16 }}>
          <span>↑↓ navigieren</span><span>⏎ öffnen</span><span>Esc schließen</span><span style={{ marginLeft: 'auto' }}>Strg/⌘ + K</span>
        </div>
      </div>
    </div>
  );
}
