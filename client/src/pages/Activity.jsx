import { useEffect, useMemo, useRef, useState } from 'react';
import { eventSocket } from '../api.js';
import { Badge, ago, usePersistentState } from '../components/ui.jsx';

const MAX = 500;

const TYPE_KIND = {
  container: 'info', image: 'muted', volume: 'ok', network: 'warn',
  service: 'info', node: 'warn', secret: 'muted', config: 'muted',
};

// Actions that signal trouble get a red tint.
const BAD = /(die|kill|oom|fail|destroy|remove|delete|error|unhealthy)/i;

export default function Activity() {
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState('Verbinde…');
  const [paused, setPaused] = useState(false);
  const [typeFilter, setTypeFilter] = usePersistentState('activity.type', 'all');
  const [q, setQ] = useState('');
  const pausedRef = useRef(false);
  const bufRef = useRef([]);

  useEffect(() => {
    const ws = eventSocket();
    ws.onopen = () => setStatus('Live');
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.type === 'event') {
          if (pausedRef.current) { bufRef.current.push(msg); return; }
          setEvents((prev) => [msg, ...prev].slice(0, MAX));
        } else if (msg.type === 'error') setStatus(`Fehler: ${msg.message}`);
      } catch { /* ignore */ }
    };
    ws.onclose = () => setStatus((s) => (s === 'Live' ? 'Getrennt' : s));
    ws.onerror = () => setStatus('Verbindungsfehler');
    return () => ws.close();
  }, []);

  const togglePause = () => {
    if (pausedRef.current) {
      const buf = bufRef.current; bufRef.current = [];
      pausedRef.current = false; setPaused(false);
      if (buf.length) setEvents((prev) => [...buf.reverse(), ...prev].slice(0, MAX));
    } else { pausedRef.current = true; setPaused(true); }
  };

  const types = useMemo(() => [...new Set(events.map((e) => e.evType))].sort(), [events]);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return events.filter((e) => {
      if (typeFilter !== 'all' && e.evType !== typeFilter) return false;
      if (!term) return true;
      return [e.evType, e.action, e.actor, e.image, e.node].some((v) => (v || '').toString().toLowerCase().includes(term));
    });
  }, [events, typeFilter, q]);

  return (
    <>
      <div className="page-head">
        <div><h1>Aktivität</h1><div className="sub">Live-Ereignisstrom der Docker-Engine</div></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={`badge ${paused ? 'warn' : status === 'Live' ? 'ok' : 'muted'}`}>{paused ? 'pausiert' : status}</span>
          <button className={`btn ${paused ? 'primary' : ''}`} onClick={togglePause}>{paused ? '▶ Fortsetzen' : '⏸ Pausieren'}</button>
          <button className="btn" onClick={() => setEvents([])}>Leeren</button>
        </div>
      </div>

      <div className="toolbar" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <input style={{ maxWidth: 260 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Filtern (Name/Aktion/Image/Node)…" />
        <label style={{ margin: '0 0 0 6px' }}>Typ:</label>
        <select style={{ width: 160 }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">Alle</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <span className="help" style={{ marginLeft: 'auto' }}>{rows.length} Ereignisse</span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">Warte auf Ereignisse… (Container starten/stoppen, Images ziehen, Volumes anlegen …)</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Zeit</th><th>Typ</th><th>Aktion</th><th>Objekt</th><th>Node</th></tr></thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={i}>
                  <td title={new Date(e.time).toLocaleString('de-DE')} style={{ whiteSpace: 'nowrap' }}>{ago(e.time)}</td>
                  <td><Badge kind={TYPE_KIND[e.evType] || 'muted'}>{e.evType}</Badge></td>
                  <td><Badge kind={BAD.test(e.action) ? 'err' : 'muted'}>{e.action}</Badge></td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.actor || '–'}{e.image && e.evType === 'container' ? <span className="help"> · {e.image}</span> : ''}</td>
                  <td className="help">{e.node || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
