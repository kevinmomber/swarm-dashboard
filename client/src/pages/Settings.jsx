import { useState, useEffect } from 'react';
import { api, postSSE } from '../api.js';
import { useApi } from '../components/useApi.js';
import { useTheme } from '../components/theme.jsx';
import { Badge, useToast, bytes, ago, Modal } from '../components/ui.jsx';
import RestoreModal from '../components/RestoreModal.jsx';
import AboutSection from '../components/AboutSection.jsx';
import AuthSection from '../components/AuthSection.jsx';
import MonitoringSection from '../components/MonitoringSection.jsx';
import RegistriesGitSection from '../components/RegistriesGitSection.jsx';
import AuditSection from '../components/AuditSection.jsx';
import EndpointsSection from '../components/EndpointsSection.jsx';
import SecretVaultSection from '../components/SecretVaultSection.jsx';
import TailscaleSection from '../components/TailscaleSection.jsx';
import GitOpsSection from '../components/GitOpsSection.jsx';

const CRON_PRESETS = [
  ['Täglich 02:00', '0 2 * * *'],
  ['Täglich 03:00', '0 3 * * *'],
  ['Stündlich', '0 * * * *'],
  ['Wöchentlich So 04:00', '0 4 * * 0'],
];

const SECTIONS = [
  { key: 'appearance', label: 'Erscheinungsbild' },
  { key: 'about', label: 'Über & Version' },
  { key: 'auth', label: 'Authentifizierung' },
  { key: 'monitoring', label: 'Monitoring' },
  { key: 'registries', label: 'Registries & Git' },
  { key: 'gitops', label: 'GitOps' },
  { key: 'endpoints', label: 'Docker-Endpoints' },
  { key: 'proxy', label: 'Reverse Proxy' },
  { key: 'tailscale', label: 'Tailscale / DockTail' },
  { key: 'backup', label: 'Backup' },
  { key: 'secretvault', label: 'Secret-Tresor' },
  { key: 'audit', label: 'Audit-Log' },
];

function download(path) {
  const a = document.createElement('a');
  a.href = `/api${path}`;
  document.body.appendChild(a); a.click(); a.remove();
}

const statusKind = (s) =>
  s === 'success' ? 'ok' : s === 'partial' ? 'warn' : s === 'running' ? 'info' : 'err';

export default function Settings() {
  const toast = useToast();
  const { theme, setTheme } = useTheme();
  const { data: services } = useApi('/backup/services', { poll: 0 });
  const { data: proxySvcs, reload: reloadProxy } = useApi('/proxy/services', { poll: 0 });
  const { data: proxyStatus, reload: reloadProxyStatus } = useApi('/proxy/status', { poll: 8000 });
  const { data: pkiCa } = useApi('/pki/ca', { poll: 0 });
  const { data: hist, reload: reloadHist } = useApi('/backup/history', { poll: 8000 });
  const { data: tsStatus } = useApi('/tailscale/status', { poll: 0 });

  const [target, setTarget] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [rp, setRp] = useState(null);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState(false);
  const [section, setSection] = useState('appearance');
  const [composeText, setComposeText] = useState(null); // string when compose modal open
  const [runProg, setRunProg] = useState(null); // live backup progress: { jobName, total, items:[{name,label,state,bytes,error}], running }

  useEffect(() => {
    api.get('/settings').then((s) => {
      setTarget(s.backup.target);
      setJobs(s.backup.jobs || []);
      setRp(s.reverseProxy);
    });
  }, []);

  if (!target || !rp) return <div className="spinner">Lade Einstellungen…</div>;

  const smb = target.smb || {};
  const setT = (patch) => setTarget({ ...target, ...patch });
  const setSmb = (patch) => setT({ smb: { ...smb, ...patch } });
  const jobSlug = (s) => (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job';
  const setJob = (i, patch) => setJobs(jobs.map((j, idx) => {
    if (idx !== i) return j;
    const next = { ...j, ...patch };
    // Keep the backup tag synced to the job name as long as the user hasn't
    // manually diverged it (tag == slug of the previous name).
    if (patch.name !== undefined && (!j.tag || j.tag === jobSlug(j.name))) next.tag = jobSlug(next.name);
    return next;
  }));

  const buildPayload = () => ({
    backup: {
      target: {
        type: target.type,
        localPath: target.localPath,
        smb: {
          host: smb.host, share: smb.share, subPath: smb.subPath,
          username: smb.username, domain: smb.domain, version: smb.version,
          ...(pw ? { password: pw } : {}),
        },
      },
      jobs: jobs.map((j) => ({
        id: j.id, name: j.name, enabled: !!j.enabled,
        schedule: j.schedule, retention: Number(j.retention) || 7, tag: j.tag || 'true',
      })),
    },
    reverseProxy: {
      type: rp.type, externalDns: rp.externalDns, entrypoint: rp.entrypoint,
      certResolver: rp.certResolver, acmeEmail: rp.acmeEmail, network: rp.network,
      tlsSource: rp.tlsSource || 'acme',
      traefikImage: (rp.traefikImage || '').trim() || 'traefik:v3.7.13',
      dashboard: rp.dashboard !== false, tls: !!rp.tls,
    },
  });

  const save = async () => {
    setBusy(true);
    try {
      const s = await api.put('/settings', buildPayload());
      setTarget(s.backup.target); setJobs(s.backup.jobs); setRp(s.reverseProxy); setPw('');
      toast('Einstellungen gespeichert');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const changeTheme = (t) => { setTheme(t); api.put('/settings', { theme: t }).catch(() => {}); };

  const testTarget = async () => {
    setBusy(true);
    try {
      const r = await api.post('/backup/test-target', buildPayload().backup.target);
      toast(r.message || 'Ziel OK');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const runJob = async (jobId) => {
    if (!confirm('Backup für diesen Job jetzt starten?')) return;
    setBusy(true);
    setRunProg({ jobName: null, total: null, items: [], running: true, error: null });
    let errMsg = null;
    try {
      await postSSE('/backup/run-stream', { jobId }, (ev) => {
        if (ev.type === 'plan') {
          setRunProg({
            jobName: ev.jobName, total: ev.total, running: true, error: null,
            items: (ev.volumes || []).map((v) => ({ name: v.name, label: v.label, type: v.type, state: 'pending', bytes: 0, error: null })),
          });
        } else if (ev.type === 'volume') {
          setRunProg((p) => {
            if (!p) return p;
            const items = p.items.map((it) => {
              if (it.name !== ev.name) return it;
              if (ev.phase === 'start') return { ...it, state: 'start' };
              if (ev.phase === 'copy') return { ...it, state: 'copy' };
              if (ev.phase === 'copy-progress') return { ...it, state: 'copy', bytes: ev.bytes || it.bytes };
              if (ev.phase === 'archive') return { ...it, state: 'archive' };
              if (ev.phase === 'done') return { ...it, state: ev.ok ? 'done' : 'failed', bytes: ev.bytes || it.bytes, error: ev.error || null };
              return it;
            });
            return { ...p, items };
          });
        } else if (ev.type === 'error') {
          errMsg = ev.message;
        } else if (ev.type === 'done') {
          const e = ev.entry;
          const ok = e.volumes.filter((v) => v.ok).length;
          setRunProg((p) => ({ ...(p || { items: [] }), running: false, status: e.status, summary: `${ok}/${e.volumes.length}` }));
          toast(`Backup ${e.status}: ${ok}/${e.volumes.length} Volumes`, e.status === 'failed' ? 'err' : 'ok');
        }
      });
      if (errMsg) throw new Error(errMsg);
      reloadHist();
    } catch (e) {
      setRunProg((p) => (p ? { ...p, running: false, error: e.message } : { running: false, error: e.message, items: [] }));
      toast(e.message, 'err');
    } finally { setBusy(false); }
  };

  const addJob = () => {
    const name = `Backup ${jobs.length + 1}`;
    setJobs([...jobs, {
      id: `job_${Date.now()}`, name, enabled: false, schedule: '0 3 * * *', retention: 7, tag: jobSlug(name),
    }]);
  };
  const removeJob = (i) => setJobs(jobs.filter((_, idx) => idx !== i));

  const applyProxy = async (id) => {
    setBusy(true);
    try { await api.post(`/proxy/apply/${id}`); toast('Traefik-Labels angewendet'); reloadProxy(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const removeProxy = async (id) => {
    if (!confirm('Reverse-Proxy-Tag von diesem Service entfernen (Labels + Netzwerk)?')) return;
    setBusy(true);
    try { await api.del(`/proxy/apply/${id}`); toast('Reverse-Proxy-Tag entfernt'); reloadProxy(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const issueCertFor = async (host) => {
    if (!host) { toast('Kein Host für dieses Routing bekannt (externen DNS setzen).', 'err'); return; }
    setBusy(true);
    try {
      await api.post('/pki/certs', { cn: host, sans: [host] });
      toast(`Zertifikat für „${host}" ausgestellt. Proxy-Stack aktualisieren, damit es aktiv wird.`, 'ok');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const setMtls = async (id, mode) => {
    setBusy(true);
    try {
      await api.post(`/proxy/mtls/${id}`, { mode });
      toast(`mTLS „${mode}" gesetzt. Proxy-Stack aktualisieren, damit es wirkt.`, 'ok');
      reloadProxy();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const setTailnet = async (id, on) => {
    setBusy(true);
    try {
      await api.post(`/proxy/tailnet/${id}`, { on });
      toast(on ? 'Über Tailscale freigegeben (Proxy-Stack ggf. aktualisieren)' : 'Tailscale-Freigabe entfernt', 'ok');
      reloadProxy();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const deployProxyStack = async () => {
    setBusy(true);
    try {
      // Persist config first so the stack reflects the current form.
      await api.put('/settings', buildPayload());
      const r = await api.post('/proxy/deploy');
      toast(`Proxy-Stack „${r.stack}" (${r.type}) deployt`, 'ok');
      reloadProxyStatus();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const removeProxyStack = async () => {
    if (!confirm('Reverse-Proxy-Stack entfernen?')) return;
    setBusy(true);
    try { await api.del('/proxy/stack'); toast('Proxy-Stack entfernt'); reloadProxyStatus(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const viewCompose = async () => {
    try {
      await api.put('/settings', buildPayload()); // reflect current form
      const text = await api.getText('/proxy/compose');
      setComposeText(text);
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Einstellungen</h1><div className="sub">Bereich wählen</div></div>
        {(section === 'proxy' || section === 'backup') && <button className="btn primary" disabled={busy} onClick={save}>Speichern</button>}
      </div>

      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <div className="pill-group">
          {SECTIONS.map((sx) => (
            <button key={sx.key} className={`btn ${section === sx.key ? 'primary' : ''}`} onClick={() => setSection(sx.key)}>{sx.label}</button>
          ))}
        </div>
      </div>

      {section === 'appearance' && (
      <div className="card section">
        <h2>Erscheinungsbild</h2>
        <div className="form-row">
          <div className="rl"><div className="t">Theme</div><div className="h">Dark oder Light Mode. Geräteübergreifend gespeichert.</div></div>
          <div className="seg">
            <button className={theme === 'dark' ? 'active' : ''} onClick={() => changeTheme('dark')}>☾ Dark</button>
            <button className={theme === 'light' ? 'active' : ''} onClick={() => changeTheme('light')}>☀ Light</button>
          </div>
        </div>
      </div>
      )}

      {section === 'about' && <AboutSection />}
      {section === 'auth' && <AuthSection />}
      {section === 'monitoring' && <MonitoringSection />}
      {section === 'registries' && <RegistriesGitSection />}
      {section === 'gitops' && <GitOpsSection />}
      {section === 'endpoints' && <EndpointsSection />}
      {section === 'secretvault' && <SecretVaultSection />}
      {section === 'tailscale' && <TailscaleSection />}
      {section === 'audit' && <AuditSection />}

      {section === 'proxy' && (
      <div className="card section">
        <h2>Reverse Proxy</h2>
        <div className="desc">Externe Erreichbarkeit getaggter Services (Label <span className="kbd">swarmdash.proxy=true</span>).</div>

        <div className="form-row">
          <div className="rl"><div className="t">Proxy-Typ</div></div>
          <div className="seg">
            {[['none', 'Aus'], ['traefik', 'Traefik'], ['nginx', 'nginx']].map(([k, l]) => (
              <button key={k} className={rp.type === k ? 'active' : ''} onClick={() => setRp({ ...rp, type: k })}>{l}</button>
            ))}
          </div>
        </div>

        {rp.type !== 'none' && (
          <>
            <div className="form-grid" style={{ marginTop: 8 }}>
              <div className="field"><label>Externer DNS-Name</label>
                <input value={rp.externalDns} onChange={(e) => setRp({ ...rp, externalDns: e.target.value })} placeholder="apps.example.com" /></div>
              {rp.type === 'traefik' && (
                <>
                  <div className="field"><label>Entrypoint</label>
                    <input value={rp.entrypoint} onChange={(e) => setRp({ ...rp, entrypoint: e.target.value })} placeholder="websecure" /></div>
                  <div className="field"><label>Cert-Resolver (optional)</label>
                    <input value={rp.certResolver} onChange={(e) => setRp({ ...rp, certResolver: e.target.value })} placeholder="letsencrypt" /></div>
                  <div className="field"><label>ACME-E-Mail (für Cert-Resolver)</label>
                    <input value={rp.acmeEmail || ''} onChange={(e) => setRp({ ...rp, acmeEmail: e.target.value })} placeholder="admin@example.com" /></div>
                  <div className="field"><label>Overlay-Netzwerk (optional)</label>
                    <input value={rp.network} onChange={(e) => setRp({ ...rp, network: e.target.value })} placeholder="traefik-public" /></div>
                  <div className="field"><label>Traefik-Image (Tag pinnen, kein :latest)</label>
                    <input value={rp.traefikImage || ''} onChange={(e) => setRp({ ...rp, traefikImage: e.target.value })} placeholder="traefik:v3.7.13" /></div>
                </>
              )}
            </div>
            <div className="form-row">
              <div className="rl"><div className="t">TLS aktiv</div><div className="h">HTTPS-Routing (Zertifikat via Resolver bzw. nginx-Zertifikat).</div></div>
              <label className="switch"><input type="checkbox" checked={!!rp.tls} onChange={(e) => setRp({ ...rp, tls: e.target.checked })} /><span className="slider" /></label>
            </div>
            {rp.type === 'traefik' && rp.tls && (
              <>
                <div className="form-row">
                  <div className="rl"><div className="t">TLS-Quelle</div><div className="h">ACME (Let's Encrypt) oder die interne PKI (Security → PKI).</div></div>
                  <div className="seg">
                    {[['acme', 'ACME'], ['internal-pki', 'Interne PKI']].map(([k, l]) => (
                      <button key={k} className={(rp.tlsSource || 'acme') === k ? 'active' : ''} onClick={() => setRp({ ...rp, tlsSource: k })}>{l}</button>
                    ))}
                  </div>
                </div>
                {rp.tlsSource === 'internal-pki' && (
                  <div className="help" style={{ marginTop: -4, marginBottom: 6 }}>
                    {pkiCa?.exists
                      ? <>Es werden alle unter <span className="kbd">Security → PKI</span> ausgestellten Zertifikate eingebunden; Traefik wählt anhand des SNI. mTLS pro Service unten einstellbar (Client-Zertifikat gegen die interne CA). Nach Zertifikats-/mTLS-Änderungen den Proxy-Stack aktualisieren.</>
                      : <span style={{ color: 'var(--amber)' }}>⚠️ Noch keine Root-CA vorhanden. Erst unter Security → PKI eine CA anlegen und Zertifikate ausstellen.</span>}
                  </div>
                )}
              </>
            )}
            {rp.type === 'traefik' && (
              <div className="form-row">
                <div className="rl"><div className="t">Traefik-Dashboard</div><div className="h">Deployt das Traefik-Dashboard mit. Mit externem DNS unter <span className="kbd">/dashboard/</span>, sonst Port 8080.</div></div>
                <label className="switch"><input type="checkbox" checked={rp.dashboard !== false} onChange={(e) => setRp({ ...rp, dashboard: e.target.checked })} /><span className="slider" /></label>
              </div>
            )}

            <div style={{ marginTop: 10 }}>
              <label>Getaggte Services</label>
              {!proxySvcs ? <div className="help">Lade…</div> :
                proxySvcs.length === 0 ? (
                  <div className="empty" style={{ padding: 20 }}>
                    Kein Service für Proxy getaggt. Über die Service-Seite → „Tag" → Reverse-Proxy.
                  </div>
                ) : (
                  <table style={{ marginTop: 6 }}>
                    <thead><tr><th>Service</th><th>Routing</th><th>Port</th><th>Status</th><th>Aktion</th></tr></thead>
                    <tbody>
                      {proxySvcs.map((s) => (
                        <tr key={s.id}>
                          <td style={{ fontWeight: 600 }}>{s.name}</td>
                          <td className="mono" style={{ fontSize: 12 }}>
                            {s.route.mode === 'host' ? s.route.host
                              : s.route.mode === 'path' ? `${s.route.host}${s.route.path}`
                                : <span className="help">externer DNS fehlt</span>}
                            {s.entrypoints && <span className="help"> · {s.entrypoints}</span>}
                          </td>
                          <td className="mono">{s.port}</td>
                          <td>
                            {s.applied && s.attached
                              ? <Badge kind="ok">aktiv</Badge>
                              : s.applied
                                ? <Badge kind="warn">Labels, kein Netz</Badge>
                                : <Badge kind="warn">nur getaggt</Badge>}
                          </td>
                          <td>{rp.type === 'traefik'
                            ? <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                                {rp.tlsSource === 'internal-pki' && (
                                  <select style={{ width: 130 }} disabled={busy} value={s.mtls || 'off'}
                                    title="mTLS (Client-Zertifikat)" onChange={(e) => setMtls(s.id, e.target.value)}>
                                    <option value="off">mTLS: aus</option>
                                    <option value="optional">mTLS: optional</option>
                                    <option value="require">mTLS: erforderlich</option>
                                  </select>
                                )}
                                {rp.tlsSource === 'internal-pki' && pkiCa?.exists && s.route.host && (
                                  <button className="btn sm" disabled={busy} onClick={() => issueCertFor(s.route.host)} title={`Zertifikat für ${s.route.host} ausstellen`}>Zertifikat</button>
                                )}
                                <button className="btn sm" disabled={busy} onClick={() => applyProxy(s.id)}>Labels anwenden</button>
                                {tsStatus?.enabled && (
                                  <button className={`btn sm ${s.tailnet ? 'primary' : ''}`} disabled={busy}
                                    title="Über Tailscale (tailnet-Entrypoint) freigeben/sperren"
                                    onClick={() => setTailnet(s.id, !s.tailnet)}>
                                    {s.tailnet ? '✓ Tailscale' : 'Tailscale'}
                                  </button>
                                )}
                                <button className="btn sm danger" disabled={busy} onClick={() => removeProxy(s.id)}>Entfernen</button>
                              </div>
                            : <span className="help">via Config</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>

            <div className="actions" style={{ marginTop: 14 }}>
              <button className="btn primary" disabled={busy} onClick={save}>Proxy-Konfig speichern</button>
              {rp.type === 'nginx' && <button className="btn" onClick={() => download('/proxy/nginx-config')}>nginx-Config herunterladen</button>}
            </div>

            <div className="card section" style={{ marginTop: 14, background: 'var(--bg-elev2)' }}>
              <h2 style={{ fontSize: 15 }}>Proxy-Stack ({rp.type === 'traefik' ? 'Traefik' : 'nginx'})</h2>
              <div className="desc">
                Erzeugt und startet den Reverse Proxy als Swarm-Stack <span className="kbd">swarmdash-proxy</span> mit der obigen Konfiguration
                (Netzwerk <span className="kbd">{(rp.network && rp.network.trim()) || 'swarmdash-proxy-net'}</span>, Ports 80{rp.tls ? '/443' : ''}).
              </div>
              <div style={{ margin: '8px 0' }}>
                {!proxyStatus ? <span className="help">Status wird geladen…</span>
                  : proxyStatus.deployed ? (
                    <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Badge kind={proxyStatus.healthy ? 'ok' : 'warn'}>{proxyStatus.healthy ? 'läuft' : 'startet…'}</Badge>
                      {proxyStatus.services.map((s) => (
                        <span key={s.id} className="mono" style={{ fontSize: 12 }}>
                          {s.name}: {s.running}/{s.desired ?? '?'}{s.ports.length ? ` (${s.ports.join(', ')})` : ''}
                        </span>
                      ))}
                    </span>
                  ) : <Badge kind="muted">nicht deployt</Badge>}
              </div>
              <div className="actions">
                <button className="btn primary" disabled={busy || rp.type === 'none'} onClick={deployProxyStack}>
                  {proxyStatus?.deployed ? 'Proxy-Stack aktualisieren' : 'Proxy-Stack deployen & starten'}
                </button>
                <button className="btn" onClick={viewCompose}>Compose ansehen</button>
                {proxyStatus?.deployed && <button className="btn danger" disabled={busy} onClick={removeProxyStack}>Stack entfernen</button>}
              </div>
              {proxyStatus?.deployed && proxyStatus.dashboard && (
                <div className="help" style={{ marginTop: 8 }}>
                  Traefik-Dashboard: <span className="mono">{proxyStatus.dashboard.url}</span>
                  {proxyStatus.dashboard.mode === 'insecure' && ' (unverschlüsselt, Port 8080)'}
                </div>
              )}
              {rp.type === 'traefik' && rp.tls && rp.certResolver && !rp.acmeEmail && (
                <div className="help" style={{ marginTop: 8, color: 'var(--amber)' }}>
                  ⚠️ Für den Cert-Resolver „{rp.certResolver}" wird eine ACME-E-Mail benötigt, sonst wird ACME übersprungen.
                </div>
              )}
              <div className="help" style={{ marginTop: 8 }}>
                Hinweis: „Labels anwenden" (Traefik) setzt die Router-Labels und hängt den Service automatisch an das Proxy-Overlay-Netz. „Entfernen" nimmt Labels und Netz-Anbindung wieder zurück.
              </div>
            </div>
            <div className="help" style={{ marginTop: 8 }}>
              Traefik: Labels werden direkt am Service gesetzt. nginx: Konfiguration wird generiert und heruntergeladen.
              Ohne eigenen DNS-Namen wird <span className="kbd">externer DNS / servicename</span> geroutet.
            </div>
          </>
        )}
      </div>
      )}

      {section === 'backup' && (<>
      {/* Backup target */}
      <div className="card section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ marginBottom: 0 }}>Backup — Ziel</h2>
          <div className="pill-group" title="Dieser Manager-Node führt die Backups aus und hält den lokalen Ziel-Pfad">
            <span className="help" style={{ fontSize: 12 }}>Aktiver Manager:</span>
            {hist?.manager?.hostname
              ? <>
                  <Badge kind="info">◈ {hist.manager.hostname}</Badge>
                  {hist.manager.leader && <Badge kind="ok">Leader</Badge>}
                </>
              : <span className="help" style={{ fontSize: 12 }}>wird ermittelt…</span>}
          </div>
        </div>
        <div className="help" style={{ marginTop: 4, marginBottom: 12 }}>
          Backups werden auf diesem Manager-Node ausgeführt; ein „Lokaler Pfad" liegt auf dessen Host-Dateisystem.
        </div>
        <div className="form-row">
          <div className="rl"><div className="t">Zieltyp</div></div>
          <div className="seg">
            <button className={target.type === 'local' ? 'active' : ''} onClick={() => setT({ type: 'local' })}>Lokaler Pfad</button>
            <button className={target.type === 'smb' ? 'active' : ''} onClick={() => setT({ type: 'smb' })}>SMB / CIFS</button>
          </div>
        </div>

        {target.type === 'local' && (
          <div className="field" style={{ marginTop: 14 }}>
            <label>Host-Pfad (auf dem Manager-Node)</label>
            <input className="mono" value={target.localPath} onChange={(e) => setT({ localPath: e.target.value })} placeholder="/backups" />
          </div>
        )}

        {target.type === 'smb' && (
          <div style={{ marginTop: 14 }}>
            <div className="form-grid">
              <div className="field"><label>Server / Host</label>
                <input value={smb.host} onChange={(e) => setSmb({ host: e.target.value })} placeholder="nas.local" /></div>
              <div className="field"><label>Share</label>
                <input value={smb.share} onChange={(e) => setSmb({ share: e.target.value })} placeholder="backups" /></div>
              <div className="field"><label>Unterordner (optional)</label>
                <input value={smb.subPath} onChange={(e) => setSmb({ subPath: e.target.value })} placeholder="swarm/prod" /></div>
              <div className="field"><label>SMB-Version</label>
                <input value={smb.version} onChange={(e) => setSmb({ version: e.target.value })} placeholder="3.0" /></div>
              <div className="field"><label>Benutzername</label>
                <input value={smb.username} onChange={(e) => setSmb({ username: e.target.value })} placeholder="backupuser" /></div>
              <div className="field"><label>Domäne (optional)</label>
                <input value={smb.domain} onChange={(e) => setSmb({ domain: e.target.value })} placeholder="WORKGROUP" /></div>
              <div className="field"><label>Passwort</label>
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
                  placeholder={smb.hasPassword ? '•••••• (gespeichert)' : 'Passwort'} /></div>
            </div>
          </div>
        )}
        <div className="actions" style={{ marginTop: 14 }}>
          <button className="btn" disabled={busy} onClick={testTarget}>Ziel testen</button>
          <button className="btn" onClick={() => setRestore(true)}>Restore…</button>
        </div>
      </div>

      {/* Backup jobs */}
      <div className="card section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div><h2 style={{ marginBottom: 2 }}>Backup — Zeitpläne</h2>
            <div className="help">Mehrere Pläne, jeweils über einen Backup-Tag den Services zugeordnet.</div></div>
          <button className="btn" onClick={addJob}>+ Job</button>
        </div>

        {jobs.length === 0 && <div className="empty" style={{ padding: 20 }}>Keine Jobs. Fügen Sie einen hinzu.</div>}

        {jobs.map((j, i) => (
          <div className="card" key={j.id} style={{ marginTop: 12, background: 'var(--bg-elev2)' }}>
            <div className="form-grid">
              <div className="field"><label>Name</label>
                <input value={j.name} onChange={(e) => setJob(i, { name: e.target.value })} /></div>
              <div className="field"><label>Backup-Tag (swarmdash.backup=…)</label>
                <input value={j.tag} onChange={(e) => setJob(i, { tag: e.target.value })} placeholder="true / db / nightly" />
                <div className="help" style={{ marginTop: 4 }}>Folgt automatisch dem Job-Namen. Services diesem Job über „Tag → Backup" zuordnen.</div></div>
              <div className="field"><label>Cron-Ausdruck</label>
                <input className="mono" value={j.schedule} onChange={(e) => setJob(i, { schedule: e.target.value })} placeholder="0 3 * * *" /></div>
              <div className="field"><label>Aufbewahrung</label>
                <input type="number" min="1" value={j.retention} onChange={(e) => setJob(i, { retention: e.target.value })} /></div>
            </div>
            <div className="pill-group" style={{ marginBottom: 10 }}>
              {CRON_PRESETS.map(([l, c]) => (
                <button key={c} className="btn sm" onClick={() => setJob(i, { schedule: c })}>{l}</button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <label className="switch"><input type="checkbox" checked={!!j.enabled} onChange={(e) => setJob(i, { enabled: e.target.checked })} /><span className="slider" /></label>
              <span className="help">{j.enabled ? 'Aktiv' : 'Deaktiviert'}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button className="btn sm" disabled={busy} onClick={() => runJob(j.id)}>Jetzt ausführen</button>
                <button className="btn sm danger" onClick={() => removeJob(i)}>Job löschen</button>
              </div>
            </div>
          </div>
        ))}
        <div className="actions" style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy} onClick={save}>Jobs speichern</button>
        </div>
      </div>

      {/* Tagged services */}
      <div className="card section">
        <h2>Zu sichernde Services</h2>
        <div className="desc">Label <span className="kbd">swarmdash.backup=&lt;tag&gt;</span> am Service. Gesichert werden dessen Named Volumes.</div>
        {!services ? <div className="help">Lade…</div> :
          services.length === 0 ? <div className="empty" style={{ padding: 20 }}>Kein Service getaggt.</div> : (
            <table>
              <thead><tr><th>Service</th><th>Backup-Tag</th><th>Job</th><th>Volumes</th></tr></thead>
              <tbody>
                {services.map((s) => {
                  const job = jobs.find((j) => j.tag === s.tag);
                  return (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600 }}>{s.name}</td>
                    <td><Badge kind="ok">{s.tag}</Badge></td>
                    <td>{job ? <Badge kind="info">{job.name}</Badge> : <span className="help">kein Job</span>}</td>
                    <td>{s.volumes.length === 0 ? <span className="help">keine</span>
                      : <div className="pill-group">{s.volumes.map((v) => <Badge key={v.name} kind={v.type === 'bind' ? 'warn' : 'info'}>{v.label || v.name}</Badge>)}</div>}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>

      {/* Live progress of a running/last manual backup */}
      {runProg && (
        <div className="card section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div>
              <h2 style={{ marginBottom: 2 }}>Backup-Fortschritt{runProg.jobName ? ` · ${runProg.jobName}` : ''}</h2>
              <div className="help">
                {runProg.running
                  ? (runProg.total ? `Läuft… ${runProg.items.filter((i) => i.state === 'done' || i.state === 'failed').length}/${runProg.total} Volumes` : 'Backup wird vorbereitet…')
                  : runProg.error ? 'Abgebrochen' : `Fertig · ${runProg.summary || ''}${runProg.status ? ` (${runProg.status})` : ''}`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {runProg.running && <span className="spinner-inline" style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />}
              {!runProg.running && <button className="btn sm" onClick={() => setRunProg(null)}>Ausblenden</button>}
            </div>
          </div>
          {runProg.error && <div className="banner" style={{ marginBottom: 8 }}>{runProg.error}</div>}
          {runProg.total > 0 && (
            <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-elev2)', overflow: 'hidden', marginBottom: 10 }}>
              <div style={{
                width: `${Math.round((runProg.items.filter((i) => i.state === 'done' || i.state === 'failed').length / runProg.total) * 100)}%`,
                height: '100%', background: 'var(--accent)', transition: 'width .25s',
              }} />
            </div>
          )}
          {runProg.items.length > 0 && (
            <div className="pill-group" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              {runProg.items.map((it) => {
                const label = {
                  pending: 'wartet', start: 'startet…', copy: 'kopiere vom Node…', archive: 'archiviere…', done: 'fertig', failed: 'Fehler',
                }[it.state] || it.state;
                const kind = it.state === 'done' ? 'ok' : it.state === 'failed' ? 'err' : it.state === 'pending' ? 'muted' : 'info';
                return (
                  <div key={it.name} style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                    <span className="mono" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340 }}>{it.label || it.name}</span>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {it.bytes > 0 && <span className="help" style={{ fontSize: 11 }}>{bytes(it.bytes)}</span>}
                      <Badge kind={kind}>{label}</Badge>
                    </span>
                  </div>
                );
              })}
              {runProg.items.some((i) => i.state === 'failed') && (
                <div style={{ marginTop: 4 }}>
                  {runProg.items.filter((i) => i.state === 'failed').map((i) => (
                    <div key={i.name} style={{ color: 'var(--red)', fontSize: 11 }}><span className="mono">{i.label || i.name}</span>: {i.error || 'Fehler'}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* History */}
      <div className="card section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div><h2 style={{ marginBottom: 2 }}>Backup-Verlauf</h2>
            <div className="help">{hist?.running ? 'Ein Backup läuft gerade…' : 'Letzte Läufe.'}</div></div>
          <button className="btn" onClick={() => setRestore(true)}>Restore…</button>
        </div>
        {hist?.history?.length ? (
          <table style={{ marginTop: 14 }}>
            <thead><tr><th>Zeitpunkt</th><th>Job</th><th>Auslöser</th><th>Status</th><th>Volumes</th><th>Größe</th></tr></thead>
            <tbody>
              {hist.history.map((h) => {
                const okv = h.volumes.filter((v) => v.ok);
                const total = okv.reduce((a, v) => a + (v.bytes || 0), 0);
                const failedV = h.volumes.filter((v) => !v.ok);
                return (
                  <tr key={h.id}>
                    <td>{ago(h.startedAt)}</td>
                    <td>{h.jobName || '–'}</td>
                    <td>{h.trigger === 'schedule' ? 'Zeitplan' : 'Manuell'}</td>
                    <td><Badge kind={statusKind(h.status)}>{h.status}</Badge>
                      {h.error && <div style={{ color: 'var(--red)', fontSize: 11 }}>{h.error}</div>}</td>
                    <td>{okv.length}/{h.volumes.length}
                      {failedV.length > 0 && (
                        <div style={{ marginTop: 4 }}>
                          {failedV.map((v) => (
                            <div key={v.name} style={{ color: 'var(--red)', fontSize: 11 }}>
                              <span className="mono">{v.label || v.name}</span>: {v.error || 'Fehler'}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="mono">{bytes(total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <div className="empty" style={{ padding: 20 }}>Noch keine Backups.</div>}
      </div>
      </>)}

      {restore && <RestoreModal onClose={() => setRestore(false)} />}
      {composeText !== null && (
        <Modal title="Compose-Definition (Reverse Proxy)" wide onClose={() => setComposeText(null)}>
          <pre style={{ margin: 0, maxHeight: '60vh', overflow: 'auto', background: 'var(--panel2, #0d1117)', padding: 12, borderRadius: 8, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre' }}>{composeText}</pre>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(composeText); toast('Kopiert'); }}>Kopieren</button>
            <button className="btn primary" onClick={() => setComposeText(null)}>Schließen</button>
          </div>
        </Modal>
      )}
    </>
  );
}
