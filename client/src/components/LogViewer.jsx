import { useEffect, useMemo, useRef, useState } from 'react';
import { logSocket } from '../api.js';
import { Modal, useToast } from './ui.jsx';

const MAX_LINES = 5000;

export default function LogViewer({ service, onClose }) {
  const toast = useToast();
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('Verbinde…');
  const [paused, setPaused] = useState(false);
  const [channel, setChannel] = useState('all'); // all | stdout | stderr
  const [search, setSearch] = useState('');
  const [bufferCount, setBufferCount] = useState(0);
  const boxRef = useRef(null);
  const autoScroll = useRef(true);
  const pausedRef = useRef(false);
  const bufferRef = useRef([]);

  useEffect(() => {
    const ws = logSocket(service.id, 300);
    ws.onopen = () => setStatus('Live');
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'log') {
          const line = { channel: msg.channel, text: msg.line };
          if (pausedRef.current) {
            bufferRef.current.push(line);
            setBufferCount(bufferRef.current.length);
          } else {
            setLines((prev) => {
              const next = [...prev, line];
              return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
            });
          }
        } else if (msg.type === 'error') {
          setStatus(`Fehler: ${msg.message}`);
        } else if (msg.type === 'end') {
          setStatus('Stream beendet');
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => setStatus((s) => (s === 'Live' ? 'Getrennt' : s));
    ws.onerror = () => setStatus('Verbindungsfehler');
    return () => ws.close();
  }, [service.id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return lines.filter((l) =>
      (channel === 'all' || l.channel === channel)
      && (!q || l.text.toLowerCase().includes(q)));
  }, [lines, channel, search]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && autoScroll.current && !paused) el.scrollTop = el.scrollHeight;
  }, [filtered, paused]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const togglePause = () => {
    if (pausedRef.current) {
      // resume: flush buffered lines
      const buf = bufferRef.current;
      bufferRef.current = [];
      setBufferCount(0);
      pausedRef.current = false;
      setPaused(false);
      if (buf.length) setLines((prev) => [...prev, ...buf].slice(-MAX_LINES));
    } else {
      pausedRef.current = true;
      setPaused(true);
    }
  };

  const clear = () => { setLines([]); bufferRef.current = []; setBufferCount(0); };

  const exportLog = () => {
    const text = filtered.map((l) => l.text).join('\n');
    if (!text) { toast('Keine Zeilen zum Export', 'err'); return; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = (service.name || 'service').replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${safe}-${stamp}.log`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast(`${filtered.length} Zeilen exportiert`);
  };

  return (
    <Modal
      wide
      title={`Logs · ${service.name}`}
      onClose={onClose}
      footer={
        <>
          <span className={`badge ${paused ? 'warn' : 'info'}`} style={{ marginRight: 'auto' }}>
            {paused ? `Pausiert${bufferCount ? ` · ${bufferCount} gepuffert` : ''}` : status}
          </span>
          <span className="help" style={{ marginRight: 8 }}>{filtered.length} / {lines.length} Zeilen</span>
          <button className="btn" onClick={clear}>Leeren</button>
          <button className="btn" onClick={onClose}>Schließen</button>
        </>
      }
    >
      <div className="toolbar" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <button className={`btn sm ${paused ? 'primary' : ''}`} onClick={togglePause}>
          {paused ? '▶ Fortsetzen' : '⏸ Pausieren'}
        </button>
        <select style={{ width: 130 }} value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="all">Alle Kanäle</option>
          <option value="stdout">stdout</option>
          <option value="stderr">stderr</option>
        </select>
        <input
          style={{ flex: 1, minWidth: 160 }}
          placeholder="🔍 Volltextsuche in Logs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn sm" onClick={exportLog}>⭳ Export</button>
      </div>
      <div className="log-view" ref={boxRef} onScroll={onScroll}>
        {filtered.length === 0 ? (
          <div style={{ color: '#5a6b7d' }}>
            {lines.length === 0 ? 'Warte auf Log-Ausgabe…' : 'Keine Zeilen entsprechen dem Filter.'}
          </div>
        ) : (
          filtered.map((l, i) => (
            <div key={i} className={`log-line ${l.channel}`}>{l.text}</div>
          ))
        )}
      </div>
    </Modal>
  );
}
