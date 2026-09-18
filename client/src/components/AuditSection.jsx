import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from './useApi.js';
import { Badge, ago, useToast } from './ui.jsx';

const kindOf = (status) => (status >= 500 ? 'err' : status >= 400 ? 'warn' : 'ok');

export default function AuditSection() {
  const toast = useToast();
  const { data, loading, reload } = useApi('/audit?limit=300', { poll: 10000 });
  const [q, setQ] = useState('');

  const rows = (data || []).filter((e) => {
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
