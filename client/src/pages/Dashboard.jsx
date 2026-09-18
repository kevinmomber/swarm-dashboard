import { useApi } from '../components/useApi.js';
import { bytes, Badge, expiryInfo, daysUntil } from '../components/ui.jsx';

function Stat({ label, value, sub, foot }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}{sub && <small> {sub}</small>}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

function svcHealth(s) {
  const us = (s.updateState || '').toLowerCase();
  if (['paused', 'rollback_paused'].includes(us)) return 'down';
  if (s.mode === 'global') return s.running === 0 ? 'down' : 'ok';
  if (s.desired === 0) return 'stopped';
  if (s.desired != null && s.running >= s.desired) return 'ok';
  if (s.running === 0) return 'down';
  return 'degraded';
}

function HealthAndPki() {
  const { data: services } = useApi('/services', { poll: 5000 });
  const { data: ca } = useApi('/pki/ca', { poll: 60000 });
  const { data: certs } = useApi('/pki/certs', { poll: 60000 });

  const svc = services || [];
  const counts = svc.reduce((a, s) => { a[svcHealth(s)] = (a[svcHealth(s)] || 0) + 1; return a; }, {});

  // PKI expiry: soonest of CA + active (non-revoked) certs, warn within 30 days.
  const expiries = [];
  if (ca?.exists && ca.notAfter) expiries.push({ name: `CA · ${ca.cn}`, notAfter: ca.notAfter });
  for (const c of certs || []) {
    if (c.status === 'revoked') continue;
    if (c.notAfter) expiries.push({ name: c.cn, notAfter: c.notAfter });
  }
  const soon = expiries
    .map((e) => ({ ...e, days: daysUntil(e.notAfter) }))
    .filter((e) => e.days !== null && e.days <= 30)
    .sort((a, b) => a.days - b.days);

  return (
    <>
      {soon.length > 0 && (
        <div className="banner" style={{ marginBottom: 16 }}>
          ⚠ {soon.length} Zertifikat(e) laufen bald ab:{' '}
          {soon.slice(0, 4).map((e, i) => (
            <span key={i} style={{ marginRight: 10 }}>
              <b>{e.name}</b> ({e.days < 0 ? 'abgelaufen' : `${e.days} Tg`})
            </span>
          ))}
          {soon.length > 4 && <span>…</span>}
        </div>
      )}
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Dienste gesund" value={counts.ok || 0}
          foot={`${svc.length} Services gesamt`} />
        <Stat label="Degradiert" value={counts.degraded || 0}
          foot={counts.stopped ? `${counts.stopped} gestoppt` : 'unter Sollzahl'} />
        <Stat label="Ausgefallen" value={counts.down || 0}
          foot={(counts.down || 0) > 0 ? 'Aufmerksamkeit nötig' : 'alles läuft'} />
        <Stat label="Zert. < 30 Tg" value={soon.length}
          foot={soon.length ? `nächstes in ${soon[0].days} Tg` : 'keine bald ablaufend'} />
      </div>
    </>
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

          {data.swarm.isManager && <HealthAndPki />}

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
