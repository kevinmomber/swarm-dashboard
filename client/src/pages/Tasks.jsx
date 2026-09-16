import { useApi } from '../components/useApi.js';
import { Badge, stateKind, short, ago } from '../components/ui.jsx';

export default function Tasks() {
  const { data, error, loading, reload } = useApi('/tasks', { poll: 5000 });

  return (
    <>
      <div className="page-head">
        <div><h1>Tasks</h1><div className="sub">Einzelne Container-Instanzen der Services</div></div>
        <button className="btn" onClick={reload}>↻ Aktualisieren</button>
      </div>

      {error && <div className="banner">{error}</div>}
      {loading && !data && <div className="spinner">Lade Tasks…</div>}
      {data && data.length === 0 && <div className="empty">Keine Tasks vorhanden.</div>}

      {data && data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Task</th><th>Node</th><th>Slot</th><th>Image</th>
                <th>Soll</th><th>Ist</th><th>Wann</th>
              </tr>
            </thead>
            <tbody>
              {data.map((t) => (
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
                  <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>{ago(t.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
