import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Badge, stateKind, short, ago } from './ui.jsx';

export default function PlacementModal({ service, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    const load = () => api.get(`/services/${service.id}/placement`).then((d) => { if (live) setData(d); }).catch((e) => live && setErr(e.message));
    load();
    const id = setInterval(load, 5000);
    return () => { live = false; clearInterval(id); };
  }, [service.id]);

  const nodes = data ? [...new Set(data.tasks.map((t) => t.node.hostname))] : [];

  return (
    <Modal title={`Platzierung · ${service.name}`} onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Schließen</button>}>
      {err && <div className="banner">{err}</div>}
      {!data && !err && <div className="help">Lade Platzierung…</div>}
      {data && data.tasks.length === 0 && <div className="empty" style={{ padding: 20 }}>Aktuell keine laufenden Tasks.</div>}
      {data && data.tasks.length > 0 && (
        <>
          <div className="help" style={{ marginBottom: 10 }}>
            {data.tasks.length} laufende(r) Task(s) auf {nodes.length} Node(s).
          </div>
          <table>
            <thead><tr><th>Node</th><th>Rolle</th><th>Slot</th><th>Status</th><th>Seit</th></tr></thead>
            <tbody>
              {data.tasks.map((t) => (
                <tr key={t.taskId}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{t.node.hostname}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{short(t.taskId)}</div>
                  </td>
                  <td>
                    {t.node.role === 'manager'
                      ? <Badge kind={t.node.leader ? 'info' : 'muted'}>{t.node.leader ? 'Manager (Leader)' : 'Manager'}</Badge>
                      : <Badge kind="muted">Worker</Badge>}
                  </td>
                  <td>{t.slot ?? '–'}</td>
                  <td><Badge kind={stateKind(t.state)}>{t.state}</Badge></td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t.timestamp ? ago(t.timestamp) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}
