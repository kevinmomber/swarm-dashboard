import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useApi } from './useApi.js';
import { Badge, useToast, ago } from './ui.jsx';

export default function MonitoringSection() {
  const toast = useToast();
  const [m, setM] = useState(null);
  const [sec, setSec] = useState({ mqtt: '', matrix: '', email: '' });
  const [busy, setBusy] = useState(false);
  const { data: status, reload } = useApi('/monitoring/status', { poll: 10000 });

  useEffect(() => { api.get('/settings').then((s) => setM(s.monitoring)).catch(() => {}); }, []);
  if (!m) return <div className="card section"><h2>Monitoring</h2><div className="help">Lade…</div></div>;

  const A = m.alerts;
  const setA = (ch, patch) => setM({ ...m, alerts: { ...A, [ch]: { ...A[ch], ...patch } } });
  const setTh = (k, v) => setM({ ...m, thresholds: { ...m.thresholds, [k]: Number(v) } });

  const payload = () => ({
    monitoring: {
      enabled: m.enabled, intervalSec: Number(m.intervalSec) || 60,
      thresholds: m.thresholds, serviceTag: m.serviceTag, mqttStatus: m.mqttStatus,
      certExpiryDays: Number(m.certExpiryDays) || 30, checkCertExpiry: !!m.checkCertExpiry, checkEndpoints: !!m.checkEndpoints,
      alerts: {
        webhook: { enabled: A.webhook.enabled, url: A.webhook.url },
        matrix: { enabled: A.matrix.enabled, homeserver: A.matrix.homeserver, roomId: A.matrix.roomId, ...(sec.matrix ? { accessToken: sec.matrix } : {}) },
        mqtt: { enabled: A.mqtt.enabled, url: A.mqtt.url, topicPrefix: A.mqtt.topicPrefix, username: A.mqtt.username, ...(sec.mqtt ? { password: sec.mqtt } : {}) },
        email: { enabled: A.email.enabled, host: A.email.host, port: Number(A.email.port) || 587, secure: A.email.secure, user: A.email.user, from: A.email.from, to: A.email.to, ...(sec.email ? { pass: sec.email } : {}) },
      },
    },
  });

  const save = async () => {
    setBusy(true);
    try { const s = await api.put('/settings', payload()); setM(s.monitoring); setSec({ mqtt: '', matrix: '', email: '' }); toast('Monitoring gespeichert'); reload(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try { await api.post('/monitoring/test'); toast('Test-Alert an aktive Kanäle gesendet'); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const ChannelToggle = ({ ch, label }) => (
    <div className="form-row">
      <div className="rl"><div className="t">{label}</div></div>
      <label className="switch"><input type="checkbox" checked={!!A[ch].enabled} onChange={(e) => setA(ch, { enabled: e.target.checked })} /><span className="slider" /></label>
    </div>
  );

  return (
    <div className="card section">
      <h2>Monitoring &amp; Alerting</h2>
      <div className="desc">Überwacht Nodes und per Label <span className="kbd">swarmdash.monitor</span> ausgewählte Services; alarmiert und meldet Status per MQTT.</div>

      <div className="form-row">
        <div className="rl"><div className="t">Monitoring aktiv</div><div className="h">Prüfintervall in Sekunden.</div></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="number" min="15" style={{ width: 90 }} value={m.intervalSec} onChange={(e) => setM({ ...m, intervalSec: e.target.value })} />
          <label className="switch"><input type="checkbox" checked={!!m.enabled} onChange={(e) => setM({ ...m, enabled: e.target.checked })} /><span className="slider" /></label>
        </div>
      </div>

      <div className="form-grid">
        <div className="field"><label>CPU-Schwelle %</label><input type="number" value={m.thresholds.cpu} onChange={(e) => setTh('cpu', e.target.value)} /></div>
        <div className="field"><label>RAM-Schwelle %</label><input type="number" value={m.thresholds.mem} onChange={(e) => setTh('mem', e.target.value)} /></div>
        <div className="field"><label>Disk-Schwelle %</label><input type="number" value={m.thresholds.disk} onChange={(e) => setTh('disk', e.target.value)} /></div>
        <div className="field"><label>Service-Tag (swarmdash.monitor=)</label><input value={m.serviceTag} onChange={(e) => setM({ ...m, serviceTag: e.target.value })} placeholder="true" /></div>
        <div className="field"><label>Zert-Warnung ab (Tage)</label><input type="number" min="1" value={m.certExpiryDays ?? 30} onChange={(e) => setM({ ...m, certExpiryDays: Number(e.target.value) })} /></div>
      </div>

      <div className="form-grid">
        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <label className="switch"><input type="checkbox" checked={!!m.checkCertExpiry} onChange={(e) => setM({ ...m, checkCertExpiry: e.target.checked })} /><span className="slider" /></label>
          <label style={{ margin: 0 }}>Zertifikatsablauf überwachen</label>
        </div>
        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <label className="switch"><input type="checkbox" checked={!!m.checkEndpoints} onChange={(e) => setM({ ...m, checkEndpoints: e.target.checked })} /><span className="slider" /></label>
          <label style={{ margin: 0 }}>Docker-Endpoints überwachen</label>
        </div>
      </div>

      <h3 style={{ margin: '16px 0 4px', fontSize: 14 }}>Alarmkanäle</h3>

      <ChannelToggle ch="webhook" label="Webhook (Endpunkt-Service)" />
      {A.webhook.enabled && <div className="field"><label>URL</label><input value={A.webhook.url} onChange={(e) => setA('webhook', { url: e.target.value })} placeholder="https://hooks.example/…" /></div>}

      <ChannelToggle ch="matrix" label="Matrix Messenger" />
      {A.matrix.enabled && (
        <div className="form-grid">
          <div className="field"><label>Homeserver</label><input value={A.matrix.homeserver} onChange={(e) => setA('matrix', { homeserver: e.target.value })} placeholder="https://matrix.org" /></div>
          <div className="field"><label>Room-ID</label><input value={A.matrix.roomId} onChange={(e) => setA('matrix', { roomId: e.target.value })} placeholder="!abc:matrix.org" /></div>
          <div className="field"><label>Access-Token</label><input type="password" value={sec.matrix} onChange={(e) => setSec({ ...sec, matrix: e.target.value })} placeholder={A.matrix.hasToken ? '•••••• (gespeichert)' : 'Token'} /></div>
        </div>
      )}

      <ChannelToggle ch="mqtt" label="MQTT (Alerts + Statusmeldungen)" />
      {A.mqtt.enabled && (
        <>
          <div className="form-grid">
            <div className="field"><label>Broker-URL</label><input value={A.mqtt.url} onChange={(e) => setA('mqtt', { url: e.target.value })} placeholder="mqtt://broker:1883" /></div>
            <div className="field"><label>Topic-Präfix</label><input value={A.mqtt.topicPrefix} onChange={(e) => setA('mqtt', { topicPrefix: e.target.value })} placeholder="swarmdash" /></div>
            <div className="field"><label>Benutzer (optional)</label><input value={A.mqtt.username} onChange={(e) => setA('mqtt', { username: e.target.value })} /></div>
            <div className="field"><label>Passwort</label><input type="password" value={sec.mqtt} onChange={(e) => setSec({ ...sec, mqtt: e.target.value })} placeholder={A.mqtt.hasPassword ? '•••••• (gespeichert)' : 'Passwort'} /></div>
          </div>
          <div className="form-row">
            <div className="rl"><div className="t">Periodische Statusmeldungen</div><div className="h">Health/Auslastung je Node & Service als retained Messages.</div></div>
            <label className="switch"><input type="checkbox" checked={!!m.mqttStatus} onChange={(e) => setM({ ...m, mqttStatus: e.target.checked })} /><span className="slider" /></label>
          </div>
        </>
      )}

      <ChannelToggle ch="email" label="E-Mail (SMTP)" />
      {A.email.enabled && (
        <div className="form-grid">
          <div className="field"><label>SMTP-Host</label><input value={A.email.host} onChange={(e) => setA('email', { host: e.target.value })} placeholder="smtp.example.com" /></div>
          <div className="field"><label>Port</label><input type="number" value={A.email.port} onChange={(e) => setA('email', { port: e.target.value })} /></div>
          <div className="field"><label>Benutzer</label><input value={A.email.user} onChange={(e) => setA('email', { user: e.target.value })} /></div>
          <div className="field"><label>Passwort</label><input type="password" value={sec.email} onChange={(e) => setSec({ ...sec, email: e.target.value })} placeholder={A.email.hasPass ? '•••••• (gespeichert)' : 'Passwort'} /></div>
          <div className="field"><label>Von</label><input value={A.email.from} onChange={(e) => setA('email', { from: e.target.value })} placeholder="swarm@example.com" /></div>
          <div className="field"><label>An</label><input value={A.email.to} onChange={(e) => setA('email', { to: e.target.value })} placeholder="ops@example.com" /></div>
        </div>
      )}

      <div className="actions" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={busy} onClick={save}>Speichern</button>
        <button className="btn" disabled={busy} onClick={test}>Test-Alert senden</button>
        {status && <span className="badge info" style={{ alignSelf: 'center' }}>{status.enabled ? 'aktiv' : 'inaktiv'}{status.mqttConnected ? ' · MQTT verbunden' : ''}</span>}
      </div>

      {status && (status.nodes.length > 0 || status.services.length > 0 || status.certs?.length > 0 || status.endpoints?.length > 0) && (
        <div style={{ marginTop: 16 }}>
          <label>Aktueller Zustand{status.lastRun ? ` · ${ago(status.lastRun)}` : ''}</label>
          <div className="pill-group" style={{ marginTop: 6 }}>
            {status.nodes.map((n) => (
              <Badge key={n.host} kind={n.healthy ? 'ok' : 'err'}>{n.host}: {n.healthy ? 'ok' : n.issues.join(', ')}</Badge>
            ))}
            {status.services.map((s) => (
              <Badge key={s.name} kind={s.healthy ? 'ok' : 'err'}>{s.name}: {s.running}/{s.desired}</Badge>
            ))}
            {(status.certs || []).map((c) => (
              <Badge key={c.name} kind={c.healthy ? 'ok' : c.days < 0 ? 'err' : 'warn'}>🔐 {c.name}: {c.days < 0 ? 'abgelaufen' : `${c.days} T`}</Badge>
            ))}
            {(status.endpoints || []).map((e) => (
              <Badge key={e.name} kind={e.healthy ? 'ok' : 'err'}>🖥 {e.name}: {e.healthy ? 'erreichbar' : 'offline'}</Badge>
            ))}
          </div>
        </div>
      )}

      {status?.log?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <label>Letzte Ereignisse</label>
          <table style={{ marginTop: 6 }}>
            <tbody>
              {status.log.slice(0, 10).map((l, i) => (
                <tr key={i}>
                  <td style={{ width: 90, color: 'var(--text-dim)', fontSize: 12 }}>{ago(l.at)}</td>
                  <td><Badge kind={l.level === 'alert' ? 'err' : l.level === 'recovery' ? 'ok' : 'info'}>{l.level}</Badge></td>
                  <td className="mono" style={{ fontSize: 12 }}>{l.target}</td>
                  <td style={{ fontSize: 12 }}>{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
