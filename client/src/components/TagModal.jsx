import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Modal, Badge, useToast } from './ui.jsx';

const TYPES = [
  { key: 'backup', label: 'Backup' },
  { key: 'monitor', label: 'Monitoring' },
  { key: 'proxy', label: 'Reverse-Proxy' },
  { key: 'group', label: 'Gruppe (Custom-Tag)' },
  { key: 'custom', label: 'Eigenes Label' },
];

export default function TagModal({ service, onClose, onApplied }) {
  const toast = useToast();
  const [type, setType] = useState('backup');
  const [backupTag, setBackupTag] = useState(service.backupTag || 'true');
  const [backupJobs, setBackupJobs] = useState([]);
  const [backupMode, setBackupMode] = useState('job'); // 'job' | 'custom'
  const [monitorTag, setMonitorTag] = useState(service.labels?.['swarmdash.monitor'] || 'true');
  const [proxyHost, setProxyHost] = useState(service.labels?.['swarmdash.proxy.host'] || '');
  const [proxyPort, setProxyPort] = useState(service.labels?.['swarmdash.proxy.port'] || '');
  const [proxyEps, setProxyEps] = useState(service.labels?.['swarmdash.proxy.entrypoints'] || '');
  const [group, setGroup] = useState(service.group || '');
  const [ck, setCk] = useState('');
  const [cv, setCv] = useState('');
  const [busy, setBusy] = useState(false);

  const current = Object.entries(service.labels || {}).filter(([k]) => k.startsWith('swarmdash.'));

  // Load backup jobs so a service can be assigned to a specific job by name.
  useEffect(() => {
    let alive = true;
    api.get('/backup/jobs').then((jobs) => {
      if (!alive) return;
      setBackupJobs(jobs || []);
      const cur = service.backupTag || service.labels?.['swarmdash.backup'] || '';
      if (cur && !(jobs || []).some((j) => j.tag === cur)) setBackupMode('custom');
      else if (cur) { setBackupMode('job'); setBackupTag(cur); }
      else if ((jobs || []).length) { setBackupMode('job'); setBackupTag(jobs[0].tag); }
    }).catch(() => setBackupMode('custom'));
    return () => { alive = false; };
  }, [service]);

  const apply = async () => {
    let add = {};
    if (type === 'backup') add = { 'swarmdash.backup': backupTag.trim() || 'true' };
    else if (type === 'monitor') add = { 'swarmdash.monitor': monitorTag.trim() || 'true' };
    else if (type === 'proxy') {
      add = { 'swarmdash.proxy': 'true' };
      if (proxyHost.trim()) add['swarmdash.proxy.host'] = proxyHost.trim();
      if (String(proxyPort).trim()) add['swarmdash.proxy.port'] = String(proxyPort).trim();
      if (proxyEps) add['swarmdash.proxy.entrypoints'] = proxyEps;
    } else if (type === 'group') {
      if (!group.trim()) return toast('Tag-Wert erforderlich', 'err');
      add = { 'swarmdash.tag': group.trim() };
    } else {
      if (!ck.trim()) return toast('Label-Schlüssel erforderlich', 'err');
      add = { [ck.trim()]: cv };
    }
    setBusy(true);
    try {
      await api.post(`/services/${service.id}/labels`, { add });
      // For Traefik reverse-proxy tagging, also apply the router labels and
      // attach the service to the proxy network in one go, so tagging "just works".
      if (type === 'proxy') {
        try {
          const r = await api.post(`/proxy/apply/${service.id}`);
          toast(r?.attached ? 'Proxy-Tag gesetzt · Labels angewendet & Netz verbunden' : 'Proxy-Tag gesetzt · Labels angewendet');
        } catch (e) {
          // nginx proxy (apply is Traefik-only) or stack not ready: keep the tag,
          // surface a hint instead of failing.
          toast(`Tag gesetzt. Hinweis: ${e.message}`, 'err');
        }
      } else {
        toast('Tag gesetzt');
      }
      onApplied?.();
      onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const removeLabel = async (key) => {
    setBusy(true);
    try {
      await api.post(`/services/${service.id}/labels`, { remove: [key] });
      toast(`Label "${key}" entfernt`);
      onApplied?.();
      onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={`Tagging · ${service.name}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Abbrechen</button>
        <button className="btn primary" disabled={busy} onClick={apply}>Tag anwenden</button>
      </>}
    >
      <div className="field">
        <label>Tag-Typ</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </div>

      {type === 'backup' && (
        <>
          <div className="field">
            <label>Backup-Job</label>
            <select
              value={backupMode === 'custom' ? '__custom__' : backupTag}
              onChange={(e) => {
                if (e.target.value === '__custom__') { setBackupMode('custom'); }
                else { setBackupMode('job'); setBackupTag(e.target.value); }
              }}
            >
              {backupJobs.map((j) => (
                <option key={j.id} value={j.tag}>{j.name} (Tag: {j.tag}){j.enabled ? '' : ' — inaktiv'}</option>
              ))}
              <option value="__custom__">Benutzerdefinierter Tag…</option>
            </select>
            <div className="help" style={{ marginTop: 6 }}>
              Ordnet den Service dem gewählten Backup-Job zu (setzt <span className="kbd">swarmdash.backup={backupMode === 'custom' ? (backupTag.trim() || '…') : backupTag}</span>).
            </div>
          </div>
          {backupMode === 'custom' && (
            <div className="field">
              <label>Benutzerdefinierter Backup-Tag</label>
              <input value={backupTag} onChange={(e) => setBackupTag(e.target.value)} placeholder="true / db / nightly" />
              <div className="help" style={{ marginTop: 6 }}>Muss dem Backup-Tag eines Jobs entsprechen, damit der Service gesichert wird.</div>
            </div>
          )}
        </>
      )}

      {type === 'monitor' && (
        <div className="field">
          <label>Monitoring-Tag (Wert von swarmdash.monitor)</label>
          <input value={monitorTag} onChange={(e) => setMonitorTag(e.target.value)} placeholder="true" />
          <div className="help" style={{ marginTop: 6 }}>Das Monitoring wählt Services über diesen Wert (Einstellungen → Monitoring → Service-Tag).</div>
        </div>
      )}

      {type === 'proxy' && (
        <>
          <div className="field">
            <label>Eigener DNS-Name (optional)</label>
            <input value={proxyHost} onChange={(e) => setProxyHost(e.target.value)} placeholder="app.example.com — leer = externer DNS + /servicename" />
          </div>
          <div className="field">
            <label>Container-Port (optional)</label>
            <input value={proxyPort} onChange={(e) => setProxyPort(e.target.value)} placeholder="z. B. 8080" />
          </div>
          <div className="field">
            <label>Entrypoints</label>
            <select value={proxyEps} onChange={(e) => setProxyEps(e.target.value)}>
              <option value="">Standard (global: TLS→websecure, sonst web)</option>
              <option value="web">Nur web (HTTP :80)</option>
              <option value="websecure">Nur websecure (HTTPS :443)</option>
              <option value="both">Beide (web → HTTPS-Redirect + websecure)</option>
            </select>
            <div className="help" style={{ marginTop: 6 }}>Überschreibt die globale Entrypoint-Wahl für diesen Service. „Beide" leitet HTTP automatisch auf HTTPS um.</div>
          </div>
        </>
      )}

      {type === 'group' && (
        <div className="field">
          <label>Gruppen-/Custom-Tag (swarmdash.tag)</label>
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="z. B. frontend" />
          <div className="help" style={{ marginTop: 6 }}>Für „Nach Custom-Tag gruppieren" in der Service-Ansicht.</div>
        </div>
      )}

      {type === 'custom' && (
        <div className="form-grid">
          <div className="field"><label>Label-Schlüssel</label>
            <input value={ck} onChange={(e) => setCk(e.target.value)} placeholder="my.label" /></div>
          <div className="field"><label>Wert</label>
            <input value={cv} onChange={(e) => setCv(e.target.value)} placeholder="wert" /></div>
        </div>
      )}

      {current.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <label>Vorhandene Swarm-Dashboard-Labels</label>
          <table style={{ marginTop: 6 }}>
            <tbody>
              {current.map(([k, v]) => (
                <tr key={k}>
                  <td><Badge kind="muted">{k}</Badge></td>
                  <td className="mono" style={{ fontSize: 12 }}>{v}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn sm danger" disabled={busy} onClick={() => removeLabel(k)}>Entfernen</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
