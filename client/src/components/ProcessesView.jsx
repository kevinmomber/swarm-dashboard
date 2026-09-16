import { useEffect, useState } from 'react';
import { api } from '../api.js';

/** Running processes inside a container/service (docker top / ps aux). */
export default function ProcessesView({ nodeId, containerId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null);
    api.get(`/containers/top?nodeId=${encodeURIComponent(nodeId || '')}&id=${encodeURIComponent(containerId)}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [nodeId, containerId, tick]);

  if (err) return <div className="banner">{err}</div>;
  if (!data) return <div className="help">Lade Prozesse…</div>;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 8, justifyContent: 'flex-end' }}>
        <button className="btn sm" onClick={() => setTick((t) => t + 1)}>↻ Aktualisieren</button>
      </div>
      <div className="table-wrap" style={{ maxHeight: '48vh', overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>#</th>
              {data.titles.map((t, i) => <th key={i}>{t}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.processes.map((row, i) => (
              <tr key={i}>
                <td className="mono" style={{ color: 'var(--text-dim)' }}>{i + 1}</td>
                {row.map((cell, j) => (
                  <td key={j} className={j === row.length - 1 ? 'mono' : ''} style={j === row.length - 1 ? { fontSize: 12, whiteSpace: 'nowrap' } : { whiteSpace: 'nowrap' }}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="help" style={{ marginTop: 6 }}>{data.processes.length} Prozess(e)</div>
    </div>
  );
}
