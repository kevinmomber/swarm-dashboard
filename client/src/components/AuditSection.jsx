import { useState, useMemo } from 'react';
import { api } from '../api.js';
import { useApi } from './useApi.js';
import { Badge, ago, useToast } from './ui.jsx';

const kindOf = (status) => (status >= 500 ? 'err' : status >= 400 ? 'warn' : 'ok');

/** Top-level path group of an audit entry, e.g. "/services/x/labels" -> "/services". */
const pathGroup = (path) => {
  const seg = (path || '').split('/').filter(Boolean)[0];
  return seg ? `/${seg}` : '/';
};

export default function AuditSection() {
  const toast = useToast();
  const { data, loading, reload } = useApi('/audit?limit=300', { poll: 10000 });
  const [q, setQ] = useState('');
  const [pathFilter, setPathFilter] = useState('');

  // Distinct path groups present in the log, for the filter dropdown.
  const pathOptions = useMemo(() => {
    const counts = new Map();
    for (const e of data || []) {
      const g = pathGroup(e.path);
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  const rows = (data || []).filter((e) => {
    if (pathFilter && pathGroup(e.path) !== pathFilter) return false;
    if (!q) return true;
    const t = q.toLowerCase();
    return [e.action, e.path, e.actor, e.method, String(e.status)].some((v) => (v || '').toString().toLowerCase().includes(t));
  });

  const clear = async () => {
    if (!window.confirm('Audit-Protokoll wirklich leeren?')) return;
    try { await api.del('/audit'); toast('Audit-Protokoll geleert'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div><h2 style={{ margin: 0 }}>Audit-Protokoll</h2>
          <div className="help">Alle ändernden Aktionen (Erstellen/Ändern/Löschen) mit Benutzer, Zeit und Ergebnis.</div>
        </div>
        <div className="spacer" style={{ flex: 1 }} />
        <select
          style={{ maxWidth: 220 }}
          value={pathFilter}
          onChange={(e) => setPathFilter(e.target.value)}
          title="Nach Log-Pfad filtern"
        >
          <option value="">Alle Pfade{data ? ` (${data.length})` : ''}</option>
          {pathOptions.map(([p, n]) => (
            <option key={p} value={p}>{p} ({n})</option>
          ))}
        </select>
        <input style={{ maxWidth: 240 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Filtern…" />
        <button className="btn" onClick={reload}>↻</button>
        <button className="btn danger" onClick={clear}>Leeren</button>
      </div>
      {loading && !data && <div className="spinner">Lade…</div>}
      {data && rows.length === 0 && <div className="empty">Keine Einträge.</div>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Zeit</th><th>Benutzer</th><th>Aktion</th><th>Pfad</th><th>Status</th><th>Dauer</th></tr></thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={i}>
                  <td title={e.at} style={{ whiteSpace: 'nowrap' }}>{ago(e.at)}</td>
                  <td>{e.actor}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.method}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.path}</td>
                  <td><Badge kind={kindOf(e.status)}>{e.status}</Badge></td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
