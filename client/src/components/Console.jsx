import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { execSocket } from '../api.js';
import { Modal } from './ui.jsx';

export default function Console({ service, onClose }) {
  const hostRef = useRef(null);
  const [status, setStatus] = useState('Verbinde…');
  const [shell, setShell] = useState('/bin/sh');
  const [gen, setGen] = useState(0); // bump to reconnect with a new shell

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      theme: { background: '#05080d', foreground: '#c9d6e3' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    setTimeout(() => { try { fit.fit(); } catch {} }, 30);

    const ws = execSocket(service.id, shell);

    const sendResize = () =>
      ws.readyState === 1 &&
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));

    ws.onopen = () => { setStatus('Verbunden'); sendResize(); };
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === 'string' && d.startsWith('{')) {
        try {
          const m = JSON.parse(d);
          if (m.__ctl) {
            if (m.__ctl === 'error') { setStatus('Fehler'); term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`); }
            else if (m.__ctl === 'ready') setStatus('Verbunden');
            else if (m.__ctl === 'end') { setStatus('Beendet'); term.write('\r\n\x1b[33m[Sitzung beendet]\x1b[0m\r\n'); }
            return;
          }
        } catch { /* fallthrough: treat as output */ }
      }
      term.write(d);
    };
    ws.onclose = () => setStatus((s) => (s === 'Verbunden' ? 'Getrennt' : s));
    ws.onerror = () => setStatus('Verbindungsfehler');

    const dispose = term.onData((data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
    });

    const onResize = () => { try { fit.fit(); sendResize(); } catch {} };
    window.addEventListener('resize', onResize);
    term.focus();

    return () => {
      window.removeEventListener('resize', onResize);
      dispose.dispose();
      ws.close();
      term.dispose();
    };
  }, [service.id, shell, gen]);

  return (
    <Modal
      wide
      title={`Konsole · ${service.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="badge info" style={{ marginRight: 'auto' }}>{status}</span>
          <select style={{ width: 130 }} value={shell} onChange={(e) => setShell(e.target.value)}>
            <option value="/bin/sh">/bin/sh</option>
            <option value="/bin/bash">/bin/bash</option>
            <option value="/bin/ash">/bin/ash</option>
          </select>
          <button className="btn" onClick={() => setGen((g) => g + 1)}>Neu verbinden</button>
          <button className="btn" onClick={onClose}>Schließen</button>
        </>
      }
    >
      <div ref={hostRef} style={{ height: 440, background: '#05080d', padding: 6, borderRadius: 8 }} />
      <div className="help" style={{ marginTop: 8 }}>
        Interaktive Shell im laufenden Container — kein SSH nötig. Erfordert, dass der Task auf dem verbundenen Node läuft.
      </div>
    </Modal>
  );
}
