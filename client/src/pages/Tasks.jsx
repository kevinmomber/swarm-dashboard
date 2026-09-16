import { useState, useMemo } from 'react';
import { useApi } from '../components/useApi.js';
import { Badge, stateKind, short, ago } from '../components/ui.jsx';

const COLUMNS = [
  { key: 'id', label: 'Task' },
  { key: 'node', label: 'Node' },
  { key: 'slot', label: 'Slot' },
  { key: 'image', label: 'Image' },
  { key: 'desiredState', label: 'Soll' },
  { key: 'state', label: 'Ist' },
  { key: 'timestamp', label: 'Wann' },
];

const distinct = (arr, key) => [...new Set(arr.map((t) => t[key]).filter((v) => v != null && v !== ''))].sort();

export default function Tasks() {
  const { data, error, loading, reload } = useApi('/tasks', { poll: 5000 });
  const [q, setQ] = useState('');
  const [node, setNode] = useState('all');
  const [image, setImage] = useState('all');
  const [desired, setDesired] = useState('all');
  const [state, setState] = useState('all');
  const [sort, setSort] = useState({ key: 'timestamp', dir: 'desc' });

  const tasks = data || [];
  const nodes = useMemo(() => distinct(tasks, 'node'), [tasks]);
  const images = useMemo(() => distinct(tasks, 'image'), [tasks]);
  const desiredStates = useMemo(() => distinct(tasks, 'desiredState'), [tasks]);
  const states = useMemo(() => distinct(tasks, 'state'), [tasks]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const filtered = tasks.filter((t) => {
      if (node !== 'all' && t.node !== node) return false;
      if (image !== 'all' && t.image !== image) return false;
      if (desired !== 'all' && t.desiredState !== desired) return false;
      if (state !== 'all' && t.state !== state) return false;
      if (!term) return true;
      return [t.id, t.node, t.image, t.desiredState, t.state, t.error, t.message]
        .some((v) => (v || '').toString().toLowerCase().includes(term));
    });
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let av = a[key]; let bv = b[key];
      if (key === 'slot') { av = av ?? -1; bv = bv ?? -1; return (av - bv) * mul; }
      if (key === 'timestamp') { return ((new Date(av).getTime() || 0) - (new Date(bv).getTime() || 0)) * mul; }
      return (av || '').toString().localeCompare((bv || '').toString(), 'de', { numeric: true }) * mul;
    });
  }, [tasks, q, node, image, desired, state, sort]);

  const toggleSort = (key) => setSort((s) => (s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' }));
  const sortIndicator = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  const resetFilters = () => { setQ(''); setNode('all'); setImage('all'); setDesired('all'); setState('all'); };
  const hasFilter = q || node !== 'all' || image !== 'all' || desired !== 'all' || state !== 'all';

  return (
    <>
      <div className="page-head">
        <div><h1>Tasks</h1><div className="sub">Einzelne Container-Instanzen der Services</div></div>
        <button className="btn" onClick={reload}>↻ Aktualisieren</button>
      </div>

      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <input style={{ maxWidth: 240 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Task / Node / Image / Status…" />
        <label style={{ margin: '0 0 0 6px' }}>Node:</label>
        <select style={{ width: 150 }} value={node} onChange={(e) => setNode(e.target.value)}>
          <option value="all">Alle</option>
          {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <label style={{ margin: '0 0 0 6px' }}>Image:</label>
        <select style={{ width: 200 }} value={image} onChange={(e) => setImage(e.target.value)}>
          <option value="all">Alle</option>
          {images.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <label style={{ margin: '0 0 0 6px' }}>Soll:</label>
        <select style={{ width: 130 }} value={desired} onChange={(e) => setDesired(e.target.value)}>
          <option value="all">Alle</option>
          {desiredStates.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label style={{ margin: '0 0 0 6px' }}>Ist:</label>
        <select style={{ width: 130 }} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="all">Alle</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {hasFilter && <button className="btn sm" onClick={resetFilters}>✕ Filter</button>}
      </div>

      {error && <div className="banner">{error}</div>}
      {loading && !data && <div className="spinner">Lade Tasks…</div>}
      {data && data.length === 0 && <div className="empty">Keine Tasks vorhanden.</div>}
      {data && data.length > 0 && rows.length === 0 && <div className="empty">Keine Tasks für die aktuellen Filter.</div>}

      {rows.length > 0 && (
        <>
          <div className="help" style={{ margin: '0 0 6px 2px' }}>{rows.length} von {tasks.length} Tasks</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} onClick={() => toggleSort(c.key)}
                      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                      title="Zum Sortieren klicken">
                      {c.label}{sortIndicator(c.key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{short(t.id)}</td>
                    <td>{t.node || '–'}</td>
                    <td>{t.slot ?? '–'}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{t.image}</td>
                    <td><Badge kind={stateKind(t.desiredState)}>{t.desiredState}</Badge></td>
                    <td>
                      <Badge kind={stateKind(t.state)}>{t.state}</Badge>
                      {t.error && <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 4 }}>{t.error}</div>}
                    </td>
                    <td style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>{ago(t.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
