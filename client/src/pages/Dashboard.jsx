import { useApi } from '../components/useApi.js';
import { bytes } from '../components/ui.jsx';

function Stat({ label, value, sub, foot }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}{sub && <small> {sub}</small>}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

export default function Dashboard() {
  const { data, error, loading } = useApi('/info', { poll: 5000 });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Übersicht</h1>
          <div className="sub">Cluster-Status auf einen Blick</div>
        </div>
      </div>

      {loading && !data && <div className="spinner">Lade Cluster-Daten…</div>}
      {error && <div className="toast err" style={{ position: 'static', marginBottom: 16 }}>{error}</div>}

      {data && !data.swarm.isManager && (
        <div className="banner">
          Der verbundene Docker-Endpoint ist kein aktiver Swarm-Manager
          (Status: {data.swarm.state}). Verwaltungsfunktionen sind eingeschränkt.
          Verbinden Sie das Backend über <code>DOCKER_HOST</code> mit einem Manager-Node.
        </div>
      )}

      {data && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <Stat label="Nodes" value={data.counts?.nodes ?? '–'}
              foot={data.counts ? `${data.counts.readyNodes} bereit` : ''} />
            <Stat label="Services" value={data.counts?.services ?? '–'}
              foot={data.counts ? `${data.counts.stacks} Stacks` : ''} />
            <Stat label="Tasks laufend" value={data.counts?.runningTasks ?? '–'}
              sub={data.counts ? `/ ${data.counts.tasks}` : ''} />
            <Stat label="Manager" value={data.swarm.managers ?? '–'}
              foot={`Swarm ${data.swarm.state}`} />
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Engine</h3>
              <table>
                <tbody>
                  <tr><td>Host</td><td className="mono">{data.hostname}</td></tr>
                  <tr><td>Docker</td><td className="mono">{data.dockerVersion}</td></tr>
                  <tr><td>OS</td><td className="mono">{data.os}</td></tr>
                  <tr><td>CPUs</td><td className="mono">{data.resources.ncpu}</td></tr>
                  <tr><td>Speicher</td><td className="mono">{bytes(data.resources.memTotal)}</td></tr>
                </tbody>
              </table>
            </div>
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Container (auf diesem Node)</h3>
              <table>
                <tbody>
                  <tr><td>Gesamt</td><td className="mono">{data.resources.containers}</td></tr>
                  <tr><td>Laufend</td><td className="mono">{data.resources.containersRunning}</td></tr>
                  <tr><td>Pausiert</td><td className="mono">{data.resources.containersPaused}</td></tr>
                  <tr><td>Gestoppt</td><td className="mono">{data.resources.containersStopped}</td></tr>
                  <tr><td>Images</td><td className="mono">{data.resources.images}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
