import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Badge } from './ui.jsx';

const statusKind = (s) => (s === 'running' ? 'ok' : s === 'degraded' ? 'warn' : 'err');

export default function StackDetailModal({ name, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    const load = () => api.get(`/stacks/${name}/detail`).then((d) => live && setData(d)).catch((e) => live && setErr(e.message));
    load();
    const id = setInterval(load, 5000);
    return () => { live = false; clearInterval(id); };
  }, [name]);

  return (
    <Modal wide title={`Stack · ${name}`} onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Schließen</button>}>
      {err && <div className="banner">{err}</div>}
      {!data && !err && <div className="help">Lade Stack-Details…</div>}

      {data && (
        <>
          {data.services.length === 0 && <div className="empty" style={{ padding: 20 }}>Keine Services deployed.</div>}
          {data.services.map((s) => (
            <div className="card" key={s.fullName} style={{ marginBottom: 12, background: 'var(--bg-elev2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div>
                  <span style={{ fontWeight: 600 }}>{s.name}</span>{' '}
                  <Badge kind={statusKind(s.status)}>{s.status}</Badge>{' '}
                  <span className="help">{s.running}{s.desired != null ? ` / ${s.desired}` : ''} · {s.mode}</span>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{s.image}</div>
                </div>
              </div>
              {s.placement.length > 0 ? (
                <table style={{ marginTop: 8 }}>
                  <thead><tr><th>Node</th><th>Rolle</th><th>Slot</th><th>Status</th></tr></thead>
                  <tbody>
                    {s.placement.map((p, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{p.node.hostname}</td>
                        <td>{p.node.role === 'manager'
                          ? <Badge kind={p.node.leader ? 'info' : 'muted'}>{p.node.leader ? 'Manager (Leader)' : 'Manager'}</Badge>
                          : <Badge kind="muted">Worker</Badge>}</td>
                        <td>{p.slot ?? '–'}</td>
                        <td><Badge kind="ok">{p.state}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="help" style={{ marginTop: 6, color: 'var(--red)' }}>Keine laufenden Tasks — Service inaktiv.</div>}
            </div>
          ))}

          {data.definedOnly.length > 0 && (
            <div className="card" style={{ marginTop: 4 }}>
              <label>In Definition, aber nicht deployed</label>
              <div className="pill-group" style={{ marginTop: 6 }}>
                {data.definedOnly.map((n) => <Badge key={n} kind="err">{n} (nicht deployed)</Badge>)}
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
