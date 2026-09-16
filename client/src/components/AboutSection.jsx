import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useToast } from './ui.jsx';

const LICENSE = `Swarm Dashboard — Nutzungsrechte

Diese Software wird "wie besehen" bereitgestellt, ohne jegliche Gewährleistung.
Die Nutzung erfolgt auf eigene Verantwortung. Das Dashboard erhält über den
Docker-Socket root-äquivalenten Zugriff auf die Swarm-Nodes; ein Betrieb ist nur
in vertrauenswürdigen Netzwerken bzw. hinter einer Authentifizierung vorgesehen.

Marken- und Namensrechte Dritter (Docker, Traefik, nginx u. a.) verbleiben bei
den jeweiligen Inhabern. Diesen Text können Sie an Ihre Anforderungen anpassen.`;

export default function AboutSection() {
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showLicense, setShowLicense] = useState(false);

  useEffect(() => { api.get('/system/version').then(setInfo).catch(() => {}); }, []);

  const doCheck = async () => {
    setBusy(true); setCheck(null);
    try { setCheck(await api.post('/system/check-update')); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const doUpdate = async () => {
    if (!confirm('Dashboard-Service auf das neueste Image aktualisieren? Der Dienst startet dabei neu.')) return;
    setBusy(true);
    try { await api.post('/system/update'); toast('Update angestoßen — der Dienst rollt neu (start-first).'); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="card section">
      <h2>Über &amp; Version</h2>
      {!info ? <div className="help">Lade…</div> : (
        <table>
          <tbody>
            <tr><td>Version</td><td className="mono">{info.version}</td></tr>
            <tr><td>Ersteller</td><td>{info.creator}</td></tr>
            <tr><td>Image</td><td className="mono" style={{ fontSize: 12 }}>{info.image || '–'}</td></tr>
            <tr><td>Service</td><td className="mono" style={{ fontSize: 12 }}>{info.service || '–'}</td></tr>
            <tr><td>Node</td><td className="mono">{info.node || '–'}</td></tr>
            <tr><td>Docker</td><td className="mono">{info.dockerVersion || '–'}</td></tr>
          </tbody>
        </table>
      )}
      {check && (
        <div className="banner" style={{ marginTop: 12, background: check.updateAvailable ? 'rgba(210,153,34,.1)' : 'rgba(63,185,80,.1)', color: check.updateAvailable ? 'var(--amber)' : 'var(--green)', borderColor: 'var(--border)' }}>
          {check.note
            ? check.note
            : check.updateAvailable
              ? `Neues Image verfügbar für ${check.tag}.`
              : `Bereits aktuell (${check.tag}).`}
        </div>
      )}
      <div className="actions" style={{ marginTop: 14 }}>
        <button className="btn" disabled={busy} onClick={doCheck}>Auf Updates prüfen</button>
        <button className="btn primary" disabled={busy} onClick={doUpdate}>Aktualisieren</button>
        <button className="btn" onClick={() => setShowLicense((v) => !v)}>{showLicense ? 'Nutzungsrechte ausblenden' : 'Nutzungsrechte anzeigen'}</button>
      </div>
      {showLicense && (
        <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-elev2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 12, fontSize: 12.5, color: 'var(--text-dim)' }}>{LICENSE}</pre>
      )}
    </div>
  );
}
