import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useApi } from './useApi.js';
import { Badge, useToast } from './ui.jsx';

const DEF = {
  enable: false, image: 'tailscale/tailscale:latest', docktailImage: 'ghcr.io/marvinvr/docktail:latest',
  hostname: 'swarmdash', tags: 'tag:server', serviceName: 'apps', entrypointPort: 8443,
  userspace: false, funnel: false, oauthClientId: '', tailnet: '',
};

export default function TailscaleSection() {
  const toast = useToast();
  const { data: status, reload: reloadStatus } = useApi('/tailscale/status', { poll: 8000 });
  const [cfg, setCfg] = useState(null);
  const [authKey, setAuthKey] = useState('');       // only sent when non-empty
  const [oauthSecret, setOauthSecret] = useState(''); // only sent when non-empty
  const [meta, setMeta] = useState({ hasAuthKey: false, hasOauthSecret: false });
  const [busy, setBusy] = useState(false);
  const [compose, setCompose] = useState(null);

  useEffect(() => {
    api.get('/settings').then((s) => {
      const t = s.tailscale || {};
      setCfg({ ...DEF, ...t });
      setMeta({ hasAuthKey: Boolean(t.hasAuthKey), hasOauthSecret: Boolean(t.hasOauthSecret) });
    }).catch((e) => toast(e.message, 'err'));
  }, []);

  if (!cfg) return <div className="card"><div className="help">Lade…</div></div>;
  const set = (patch) => setCfg({ ...cfg, ...patch });

  const save = async () => {
    setBusy(true);
    try {
      const payload = { tailscale: {
        enable: cfg.enable, image: cfg.image, docktailImage: cfg.docktailImage, hostname: cfg.hostname,
        tags: cfg.tags, serviceName: cfg.serviceName, entrypointPort: Number(cfg.entrypointPort) || 8443,
        userspace: cfg.userspace, funnel: cfg.funnel, oauthClientId: cfg.oauthClientId, tailnet: cfg.tailnet,
      } };
      if (authKey) payload.tailscale.authKey = authKey;
      if (oauthSecret) payload.tailscale.oauthClientSecret = oauthSecret;
      await api.put('/settings', payload);
      setAuthKey(''); setOauthSecret('');
      if (authKey) setMeta((m) => ({ ...m, hasAuthKey: true }));
      if (oauthSecret) setMeta((m) => ({ ...m, hasOauthSecret: true }));
      toast('Tailscale-Konfiguration gespeichert');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const deploy = async () => {
    setBusy(true);
    try {
      await api.put('/settings', {
        tailscale: { ...cfg, entrypointPort: Number(cfg.entrypointPort) || 8443,
          ...(authKey ? { authKey } : {}), ...(oauthSecret ? { oauthClientSecret: oauthSecret } : {}) },
      });
      const r = await api.post('/tailscale/deploy');
      toast(`Stack „${r.stack}" deployt${r.proxyRedeployed ? ' (Traefik aktualisiert)' : ''}`);
      reloadStatus();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const remove = async (purge) => {
    if (!window.confirm(purge ? 'Stack entfernen UND den Tailscale-State (Node-Identität) löschen?' : 'Tailscale/DockTail-Stack entfernen? (State-Volume bleibt erhalten.)')) return;
    setBusy(true);
    try { const r = await api.del(`/tailscale/stack${purge ? '?purgeState=true' : ''}`); toast(`Stack entfernt${r.purged ? ' + State gelöscht' : ''}`); reloadStatus(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const viewCompose = async () => {
    try { setCompose(await api.getText('/tailscale/compose')); }
    catch (e) { toast(e.message, 'err'); }
  };

  return (
    <div className="card">
      <div style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Tailscale / DockTail</h2>
        <div className="help">
          Betreibt <span className="kbd">tailscaled</span> + <span className="kbd">DockTail</span> als Stack <span className="kbd">swarmdash-tailscale</span> und
          veröffentlicht ausgewählte Services über das Tailnet. DockTail exponiert dabei ausschließlich Traefiks
          dedizierten <span className="kbd">tailnet</span>-Entrypoint; die Freigabe je Service erfolgt im Reiter
          „Reverse Proxy" (Button „Tailscale"). Läuft zusätzlich zum internen Traefik.
        </div>
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginBottom: 12 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={cfg.enable} onChange={(e) => set({ enable: e.target.checked })} />
        <b>Feature aktivieren</b>
      </label>

      <div className="form-grid">
        <div className="field"><label>Tailscale-Image</label>
          <input value={cfg.image} onChange={(e) => set({ image: e.target.value })} placeholder="tailscale/tailscale:latest" /></div>
        <div className="field"><label>DockTail-Image</label>
          <input value={cfg.docktailImage} onChange={(e) => set({ docktailImage: e.target.value })} placeholder="ghcr.io/marvinvr/docktail:latest" /></div>
        <div className="field"><label>Hostname (Tailnet-Node)</label>
          <input value={cfg.hostname} onChange={(e) => set({ hostname: e.target.value })} placeholder="swarmdash" /></div>
        <div className="field"><label>ACL-Tags (advertise-tags)</label>
          <input value={cfg.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="tag:server" /></div>
        <div className="field"><label>DockTail-Servicename (Tailnet-Host)</label>
          <input value={cfg.serviceName} onChange={(e) => set({ serviceName: e.target.value })} placeholder="apps" /></div>
        <div className="field"><label>Traefik tailnet-Port</label>
          <input type="number" value={cfg.entrypointPort} onChange={(e) => set({ entrypointPort: e.target.value })} placeholder="8443" /></div>
      </div>

      <div className="form-grid">
        <div className="field"><label>TS_AUTHKEY {meta.hasAuthKey && <Badge kind="ok">gesetzt</Badge>}</label>
          <input type="password" value={authKey} onChange={(e) => setAuthKey(e.target.value)}
            placeholder={meta.hasAuthKey ? '•••••• (gespeichert)' : 'tskey-auth-…'} /></div>
        <div className="field"><label>OAuth Client-ID (optional)</label>
          <input value={cfg.oauthClientId} onChange={(e) => set({ oauthClientId: e.target.value })} placeholder="k123…" /></div>
        <div className="field"><label>OAuth Client-Secret {meta.hasOauthSecret && <Badge kind="ok">gesetzt</Badge>}</label>
          <input type="password" value={oauthSecret} onChange={(e) => setOauthSecret(e.target.value)}
            placeholder={meta.hasOauthSecret ? '•••••• (gespeichert)' : 'tskey-client-…'} /></div>
        <div className="field"><label>Tailnet (nur Anzeige)</label>
          <input value={cfg.tailnet} onChange={(e) => set({ tailnet: e.target.value })} placeholder="example.ts.net" /></div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '4px 0 12px' }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={cfg.funnel} onChange={(e) => set({ funnel: e.target.checked })} />
          Funnel (öffentlich im Internet exponieren)
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={cfg.userspace} onChange={(e) => set({ userspace: e.target.checked })} />
          Userspace-Modus (ohne /dev/net/tun; kein Subnet-Routing)
        </label>
      </div>

      <div className="banner" style={{ marginBottom: 12 }}>
        Voraussetzung im Tailscale-Admin: ein Authkey <i>oder</i> OAuth-Client (Scope „Services: Write", „Devices: Core: Write"),
        sowie ACL-Einträge (<span className="kbd">tagOwners</span>, <span className="kbd">autoApprovers.services</span>, für Funnel
        <span className="kbd">nodeAttrs</span>/funnel). Diese Einrichtung kann das Dashboard nicht automatisieren.
      </div>

      <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy} onClick={save}>Speichern</button>
        <button className="btn" disabled={busy} onClick={viewCompose}>Compose anzeigen</button>
        <div style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !cfg.enable} onClick={deploy}>
          {status?.deployed ? 'Stack aktualisieren' : 'Stack deployen & starten'}
        </button>
        {status?.deployed && <button className="btn danger" disabled={busy} onClick={() => remove(false)}>Stack entfernen</button>}
        {status?.deployed && <button className="btn danger" disabled={busy} onClick={() => remove(true)}>Stack + State löschen</button>}
      </div>

      <div className="card section" style={{ marginTop: 14, background: 'var(--bg-elev2)' }}>
        <h2 style={{ fontSize: 15 }}>Stack-Status</h2>
        {!status ? <span className="help">Status wird geladen…</span>
          : status.deployed ? (
            <table style={{ marginTop: 6 }}>
              <thead><tr><th>Service</th><th>Image</th><th>Replikas</th></tr></thead>
              <tbody>
                {status.services.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600 }}>{s.name}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{s.image}</td>
                    <td><Badge kind={s.running === s.desired ? 'ok' : 'warn'}>{s.running}/{s.desired}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="help" style={{ marginTop: 6 }}>Nicht deployt.{!cfg.enable && ' Feature ist deaktiviert.'}</div>}
      </div>

      {compose !== null && (
        <div className="card section" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: 15, margin: 0 }}>Compose-Vorschau</h2>
            <button className="btn sm" onClick={() => setCompose(null)}>Schließen</button>
          </div>
          <pre style={{ margin: '8px 0 0', maxHeight: '50vh', overflow: 'auto', background: 'var(--panel2, #0d1117)', padding: 12, borderRadius: 8, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre' }}>{compose}</pre>
        </div>
      )}
    </div>
  );
}
