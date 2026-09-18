import { useState, useEffect, useCallback } from 'react';
import { api, downloadBase64 } from '../api.js';
import { Modal, Badge, useToast } from './ui.jsx';

const BITS = [2048, 3072, 4096];
const REVOKE_REASONS = [
  ['unspecified', 'Nicht spezifiziert'],
  ['keyCompromise', 'Schlüssel kompromittiert'],
  ['superseded', 'Ersetzt'],
  ['cessationOfOperation', 'Betrieb eingestellt'],
  ['affiliationChanged', 'Zugehörigkeit geändert'],
];

const fmtDate = (iso) => {
  if (!iso) return '–';
  try { return new Date(iso).toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { return iso; }
};
const daysLeft = (iso) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);

function StatusBadge({ cert }) {
  if (cert.status === 'revoked') return <Badge kind="err">gesperrt</Badge>;
  if (cert.status === 'expired') return <Badge kind="err">abgelaufen</Badge>;
  const dl = daysLeft(cert.notAfter);
  if (dl <= 30) return <Badge kind="warn">läuft in {dl} T ab</Badge>;
  return <Badge kind="ok">gültig</Badge>;
}

/* -------------------- CA create -------------------- */
function CaCreateForm({ onCreated }) {
  const toast = useToast();
  const [cn, setCn] = useState('Swarm Dashboard Root CA');
  const [org, setOrg] = useState('');
  const [days, setDays] = useState(3650);
  const [bits, setBits] = useState(4096);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!cn.trim()) { toast('Common Name erforderlich', 'err'); return; }
    setBusy(true);
    try {
      await api.post('/pki/ca', { cn: cn.trim(), org: org.trim(), days: Number(days), bits: Number(bits) });
      toast('Root-CA erstellt');
      onCreated();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h3 style={{ marginTop: 0 }}>Root-CA anlegen</h3>
      <div className="help" style={{ marginBottom: 12 }}>
        Erzeugt eine selbstsignierte Zertifizierungsstelle. Der private CA-Schlüssel wird
        ausschließlich serverseitig gespeichert und niemals ausgegeben.
      </div>
      <label className="field"><span>Common Name (CN)</span>
        <input value={cn} onChange={(e) => setCn(e.target.value)} placeholder="Swarm Dashboard Root CA" />
      </label>
      <label className="field"><span>Organisation (optional)</span>
        <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Meine Firma" />
      </label>
      <div style={{ display: 'flex', gap: 12 }}>
        <label className="field" style={{ flex: 1 }}><span>Gültigkeit (Tage)</span>
          <input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <label className="field" style={{ flex: 1 }}><span>Schlüssellänge</span>
          <select value={bits} onChange={(e) => setBits(e.target.value)}>
            {BITS.map((b) => <option key={b} value={b}>{b} bit</option>)}
          </select>
        </label>
      </div>
      <div style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={submit}>
          {busy ? 'Erzeuge…' : 'Root-CA erstellen'}
        </button>
      </div>
    </div>
  );
}

/* -------------------- issue leaf -------------------- */
function IssueModal({ onClose, onDone }) {
  const toast = useToast();
  const [cn, setCn] = useState('');
  const [sans, setSans] = useState('');
  const [days, setDays] = useState(825);
  const [bits, setBits] = useState(2048);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!cn.trim()) { toast('Common Name erforderlich', 'err'); return; }
    setBusy(true);
    try {
      const sanList = sans.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      await api.post('/pki/certs', { cn: cn.trim(), sans: sanList, days: Number(days), bits: Number(bits) });
      toast(`Zertifikat für „${cn.trim()}" ausgestellt`);
      onDone();
      onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title="Zertifikat ausstellen" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Abbrechen</button>
        <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Stelle aus…' : 'Ausstellen'}</button>
      </>}>
      <label className="field"><span>Common Name (CN) – i.d.R. der Hostname</span>
        <input value={cn} onChange={(e) => setCn(e.target.value)} placeholder="app.example.com" autoFocus />
      </label>
      <label className="field"><span>Subject Alternative Names (kommagetrennt, optional)</span>
        <textarea rows={3} value={sans} onChange={(e) => setSans(e.target.value)}
          placeholder="app.example.com, www.example.com, 192.168.1.50" />
      </label>
      <div className="help" style={{ marginBottom: 10 }}>
        Der CN wird automatisch als DNS-SAN ergänzt. Moderne Browser werten ausschließlich SANs.
        IPv4-Adressen werden als IP-SAN eingetragen.
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <label className="field" style={{ flex: 1 }}><span>Gültigkeit (Tage)</span>
          <input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <label className="field" style={{ flex: 1 }}><span>Schlüssellänge</span>
          <select value={bits} onChange={(e) => setBits(e.target.value)}>
            {BITS.map((b) => <option key={b} value={b}>{b} bit</option>)}
          </select>
        </label>
      </div>
    </Modal>
  );
}

/* -------------------- cert detail -------------------- */
function CertDetail({ cert, onClose, onDeleted }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [chk, setChk] = useState(false);
  const [reason, setReason] = useState('unspecified');

  useEffect(() => {
    api.get(`/pki/certs/${cert.id}`).then(setD).catch((e) => setErr(e.message));
  }, [cert.id]);

  const dl = (fmt) => {
    const a = document.createElement('a');
    a.href = `/api/pki/certs/${cert.id}/download?fmt=${fmt}`;
    document.body.appendChild(a); a.click(); a.remove();
  };
  const dlP12 = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/pki/certs/${cert.id}/p12`, { passphrase: pass });
      downloadBase64(r.dataB64, r.filename);
      toast('PKCS#12 heruntergeladen');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const del = async () => {
    setBusy(true);
    try { await api.del(`/pki/certs/${cert.id}`); toast('Zertifikat gelöscht'); onDeleted(); onClose(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const revoke = async () => {
    setBusy(true);
    try {
      await api.post(`/pki/certs/${cert.id}/revoke`, { reason });
      toast('Zertifikat gesperrt und CRL aktualisiert');
      onDeleted();
      const fresh = await api.get(`/pki/certs/${cert.id}`);
      setD(fresh);
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal wide title={`Zertifikat · ${cert.cn}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Schließen</button></>}>
      {err && <div className="banner">{err}</div>}
      {!d && !err && <div className="help">Lade…</div>}
      {d && (
        <>
          <table className="kv" style={{ marginBottom: 14 }}>
            <tbody>
              <tr><td>Common Name</td><td className="mono">{d.meta.cn}</td></tr>
              <tr><td>SANs</td><td className="mono">{(d.meta.sans || []).join(', ') || '–'}</td></tr>
              <tr><td>Serie</td><td className="mono">{d.meta.serialHex}</td></tr>
              <tr><td>Status</td><td><StatusBadge cert={d.meta} /></td></tr>
              <tr><td>Gültig von</td><td className="mono">{fmtDate(d.meta.notBefore)}</td></tr>
              <tr><td>Gültig bis</td><td className="mono">{fmtDate(d.meta.notAfter)}</td></tr>
              <tr><td>Schlüssel</td><td className="mono">{d.meta.bits} bit RSA</td></tr>
              {d.meta.revoked && <tr><td>Gesperrt am</td><td className="mono">{fmtDate(d.meta.revokedAt)} · {d.meta.reason || 'unspecified'}</td></tr>}
            </tbody>
          </table>

          <div className="sub" style={{ marginBottom: 6 }}>Download</div>
          <div className="actions" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
            <button className="btn sm" onClick={() => dl('cert')}>⭳ Zertifikat (.crt)</button>
            <button className="btn sm" onClick={() => dl('key')}>⭳ Schlüssel (.key)</button>
            <button className="btn sm" onClick={() => dl('fullchain')}>⭳ Fullchain</button>
            <button className="btn sm" onClick={() => dl('chain')}>⭳ CA-Chain</button>
          </div>

          <div className="sub" style={{ marginBottom: 6 }}>PKCS#12 (.p12 – Cert + Schlüssel + CA)</div>
          <div className="actions" style={{ gap: 6, marginBottom: 16, alignItems: 'center' }}>
            <input type="password" style={{ maxWidth: 220 }} value={pass}
              onChange={(e) => setPass(e.target.value)} placeholder="Passphrase (optional)" />
            <button className="btn sm" disabled={busy} onClick={dlP12}>⭳ .p12 erzeugen</button>
          </div>

          <details>
            <summary className="help" style={{ cursor: 'pointer' }}>PEM anzeigen</summary>
            <div className="sub" style={{ margin: '8px 0 4px' }}>Zertifikat</div>
            <textarea readOnly rows={7} className="mono" style={{ width: '100%', fontSize: 11 }} value={d.certPem} />
            <div className="sub" style={{ margin: '8px 0 4px' }}>Privater Schlüssel</div>
            <textarea readOnly rows={7} className="mono" style={{ width: '100%', fontSize: 11 }} value={d.keyPem} />
          </details>

          <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 12 }}>
            {!d.meta.revoked && (
              <div style={{ marginBottom: 14 }}>
                <div className="sub" style={{ marginBottom: 6 }}>Sperren (Revocation)</div>
                <div className="help" style={{ marginBottom: 6 }}>
                  Trägt das Zertifikat in die CRL ein und entfernt es aus der Traefik-Auslieferung (Server-Zerts) beim nächsten Proxy-Update.
                </div>
                <div className="actions" style={{ gap: 6, alignItems: 'center' }}>
                  <select style={{ maxWidth: 240 }} value={reason} onChange={(e) => setReason(e.target.value)}>
                    {REVOKE_REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <button className="btn sm danger" disabled={busy} onClick={revoke}>Zertifikat sperren</button>
                </div>
              </div>
            )}
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input type="checkbox" checked={chk} onChange={(e) => setChk(e.target.checked)} />
              <span>Ja, dieses Zertifikat endgültig entfernen.</span>
            </label>
            <button className="btn danger" disabled={busy || !chk} onClick={del}>Zertifikat löschen</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* -------------------- reset -------------------- */
function ResetModal({ onClose, onDone }) {
  const toast = useToast();
  const [chk, setChk] = useState(false);
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    setBusy(true);
    try { await api.del('/pki/ca'); toast('PKI zurückgesetzt'); onDone(); onClose(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="PKI zurücksetzen" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Abbrechen</button>
        <button className="btn danger" disabled={busy || !chk} onClick={reset}>Zurücksetzen</button>
      </>}>
      <div className="banner" style={{ marginBottom: 12 }}>
        Achtung: Dies löscht die Root-CA <b>und alle ausgestellten Zertifikate</b> unwiderruflich.
        Bereits verteilte Zertifikate werden dadurch ungültig.
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={chk} onChange={(e) => setChk(e.target.checked)} />
        <span>Ja, die gesamte PKI endgültig löschen.</span>
      </label>
    </Modal>
  );
}

/* -------------------- main -------------------- */
export default function PkiPanel() {
  const [ca, setCa] = useState(null);
  const [certs, setCerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [issue, setIssue] = useState(false);
  const [detail, setDetail] = useState(null);
  const [reset, setReset] = useState(false);
  const [crl, setCrl] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const st = await api.get('/pki/ca');
      setCa(st);
      setCerts(st.exists ? await api.get('/pki/certs') : []);
      setCrl(st.exists ? await api.get('/pki/crl/status') : null);
      setErr(null);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toast = useToast();
  const reconcile = async () => {
    try {
      const r = await api.post('/proxy/reconcile-pki', {});
      if (r.reconciled) toast(`Proxy abgeglichen${r.redeployed ? ' (neu deployt)' : ''}${typeof r.prunedOrphans === 'number' ? ` · ${r.prunedOrphans} verwaiste Config(s) entfernt` : ''}`, 'ok');
      else toast(`Abgleich nicht möglich: ${r.error || 'unbekannt'}`, 'err');
    } catch (e) { toast(e.message, 'err'); }
  };

  if (loading && !ca) return <div className="spinner">Lade PKI…</div>;
  if (err) return <div className="banner">{err}</div>;

  if (ca && !ca.exists) return <CaCreateForm onCreated={load} />;

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="sub">Root-Zertifizierungsstelle</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{ca.cn}</div>
            {ca.org && <div className="help">{ca.org}</div>}
            <div className="help" style={{ marginTop: 4 }}>
              Gültig bis {fmtDate(ca.notAfter)}
              {ca.notAfter && (() => { const dl = daysLeft(ca.notAfter); return dl <= 60
                ? <> <Badge kind={dl <= 30 ? 'err' : 'warn'}>läuft in {dl} T ab</Badge></>
                : <> <Badge kind="ok">{dl} T gültig</Badge></>; })()}
              {' '}· {ca.bits} bit · {ca.certCount} Zertifikate ausgestellt
            </div>
            <div className="mono help" style={{ marginTop: 4, fontSize: 10, wordBreak: 'break-all' }}>
              SHA-256: {ca.fingerprint}
            </div>
          </div>
          <div className="actions" style={{ flexWrap: 'wrap', gap: 6 }}>
            <a className="btn sm" href="/api/pki/ca/download">⭳ Root-CA</a>
            <button className="btn sm" onClick={reconcile} title="Traefik mit der aktuellen PKI abgleichen und verwaiste Zertifikat-Configs entfernen">Proxy abgleichen</button>
            <button className="btn sm danger" onClick={() => setReset(true)}>PKI zurücksetzen</button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="sub">Sperrliste (CRL)</div>
            <div className="help" style={{ marginTop: 4 }}>
              {crl ? <>CRL-Nr. {crl.number} · {crl.revokedCount} gesperrt · gültig bis {fmtDate(crl.nextUpdate)}</> : '–'}
            </div>
            <div className="help" style={{ marginTop: 4 }}>
              Signierte X.509-CRL zur Verteilung an externe Prüfer. Hinweis: Traefik prüft die CRL nicht selbst —
              gesperrte <b>Server</b>-Zerts werden beim nächsten Proxy-Update aus der Auslieferung genommen; gesperrte
              <b> Client</b>-Zerts (mTLS) bleiben bis zum Ablauf gültig.
            </div>
          </div>
          <div className="actions" style={{ flexWrap: 'wrap', gap: 6 }}>
            <a className="btn sm" href="/api/pki/crl">⭳ CRL (.pem)</a>
          </div>
        </div>
      </div>

      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className="btn primary" onClick={() => setIssue(true)}>+ Zertifikat ausstellen</button>
        <button className="btn" onClick={load}>↻ Aktualisieren</button>
      </div>

      <div className="help" style={{ marginTop: -4, marginBottom: 12 }}>
        Damit Zertifikate im Reverse Proxy wirksam werden: unter <span className="kbd">Einstellungen → Reverse Proxy</span> die
        TLS-Quelle „Interne PKI" wählen und den Proxy-Stack (neu) deployen bzw. nach Änderungen aktualisieren.
      </div>

      {certs.length === 0 && <div className="empty">Noch keine Zertifikate ausgestellt.</div>}
      {certs.length > 0 && (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 640 }}>
            <thead>
              <tr><th>Common Name</th><th>SANs</th><th>Status</th><th>Gültig bis</th><th>Serie</th><th>Aktion</th></tr>
            </thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.id}>
                  <td className="mono" style={{ fontWeight: 600 }}>{c.cn}</td>
                  <td className="mono" style={{ fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={(c.sans || []).join(', ')}>
                    {(c.sans || []).join(', ') || '–'}
                  </td>
                  <td><StatusBadge cert={c} /></td>
                  <td className="mono" style={{ fontSize: 12 }}>{fmtDate(c.notAfter)}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.serialHex}</td>
                  <td>
                    <div className="actions" style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn sm" onClick={() => setDetail(c)}>Details</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {issue && <IssueModal onClose={() => setIssue(false)} onDone={load} />}
      {detail && <CertDetail cert={detail} onClose={() => setDetail(null)} onDeleted={load} />}
      {reset && <ResetModal onClose={() => setReset(false)} onDone={load} />}
    </>
  );
}
