import { useState, useRef } from 'react';
import { api } from '../api.js';
import { useApi } from './useApi.js';
import { Badge, ago, useToast } from './ui.jsx';

export default function SecretVaultSection() {
  const toast = useToast();
  const { data: status, loading, reload } = useApi('/secret-vault/status', { poll: 0 });
  const [pass, setPass] = useState('');
  const [initPass, setInitPass] = useState('');
  const [initPass2, setInitPass2] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [alsoDocker, setAlsoDocker] = useState(true);
  const [busy, setBusy] = useState(false);
  const [recResult, setRecResult] = useState(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [importMode, setImportMode] = useState('merge');
  const fileRef = useRef(null);

  const init = async () => {
    if (initPass.length < 6) return toast('Passphrase zu kurz (min. 6 Zeichen)', 'err');
    if (initPass !== initPass2) return toast('Passphrasen stimmen nicht überein', 'err');
    setBusy(true);
    try { await api.post('/secret-vault/init', { passphrase: initPass }); toast('Tresor initialisiert'); setInitPass(''); setInitPass2(''); reload(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const addEntry = async () => {
    if (!pass) return toast('Bitte Tresor-Passphrase eingeben', 'err');
    if (!name || !value) return toast('Name und Wert erforderlich', 'err');
    setBusy(true);
    try {
      await api.post('/secret-vault/entry', { passphrase: pass, name, value });
      if (alsoDocker) {
        try { await api.post('/secrets', { name, data: value }); }
        catch (e) { toast(`Im Tresor gespeichert, aber Docker-Secret: ${e.message}`, 'err'); }
      }
      toast(`„${name}" gespeichert${alsoDocker ? ' (Tresor + Docker)' : ' (Tresor)'}`);
      setName(''); setValue(''); reload();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const delEntry = async (n) => {
    if (!window.confirm(`Eintrag „${n}" aus dem Tresor entfernen? (Das Docker-Secret bleibt unberührt.)`)) return;
    try { await api.del(`/secret-vault/entry/${encodeURIComponent(n)}`); toast('Eintrag entfernt'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const exportVault = async () => {
    try {
      const json = await api.getText('/secret-vault/export');
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `secret-vault-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast('Verschlüsselter Tresor exportiert');
    } catch (e) { toast(e.message, 'err'); }
  };

  const doImport = async (file) => {
    if (!file) return;
    if (importMode === 'replace' && !window.confirm('Import im Modus „Ersetzen": der aktuelle Tresor wird vollständig überschrieben. Fortfahren?')) return;
    setBusy(true);
    try {
      const content = await file.text();
      const body = { content, mode: importMode };
      if (importMode === 'merge') { if (!pass) { setBusy(false); return toast('Für „Zusammenführen" die Passphrase eingeben (muss zu beiden Tresoren passen)', 'err'); } body.passphrase = pass; }
      const r = await api.post('/secret-vault/import', body);
      toast(`Import ok (${r.mode}): ${r.count} Einträge`); reload();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const recreate = async () => {
    if (!pass) return toast('Bitte Tresor-Passphrase eingeben', 'err');
    if (!window.confirm(`Alle ${status?.count || 0} Secrets aus dem Tresor als Docker-Secrets (neu) anlegen?${replaceExisting ? '\nBestehende gleichnamige Secrets werden ersetzt (sofern nicht in Verwendung).' : ''}`)) return;
    setBusy(true); setRecResult(null);
    try {
      const r = await api.post('/secret-vault/recreate', { passphrase: pass, replaceExisting });
      setRecResult(r.results || []);
      toast(`Wiederhergestellt: ${r.ok}/${r.total}${r.failed ? `, ${r.failed} fehlgeschlagen` : ''}`, r.failed ? 'err' : 'ok');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const changePass = async () => {
    const oldP = window.prompt('Aktuelle Passphrase:');
    if (oldP == null) return;
    const newP = window.prompt('Neue Passphrase (min. 6 Zeichen):');
    if (newP == null) return;
    setBusy(true);
    try { const r = await api.post('/secret-vault/passphrase', { oldPassphrase: oldP, newPassphrase: newP }); toast(`Passphrase geändert (${r.count} Einträge neu verschlüsselt)`); setPass(''); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const destroy = async () => {
    if (!window.confirm('Den gesamten Tresor unwiderruflich löschen? Alle verschlüsselten Secret-Werte gehen verloren. (Docker-Secrets bleiben unberührt.)')) return;
    try { await api.del('/secret-vault'); toast('Tresor gelöscht'); setPass(''); setRecResult(null); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };

  if (loading && !status) return <div className="card"><div className="help">Lade…</div></div>;

  return (
    <div className="card">
      <div style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Secret-Tresor</h2>
        <div className="help">
          Passphrase-verschlüsselter Speicher (AES-256-GCM) für Docker-Secret-Werte — getrennt vom zentralen Backup.
          Docker-Secrets sind „write-only": ihr Inhalt kann nicht ausgelesen werden, daher wird der Wert hier beim Anlegen gesichert.
          Die Passphrase wird nie gespeichert.
        </div>
      </div>

      {!status?.initialized ? (
        <div className="section" style={{ maxWidth: 480 }}>
          <div className="field"><label>Neue Passphrase (min. 6 Zeichen)</label>
            <input type="password" value={initPass} onChange={(e) => setInitPass(e.target.value)} placeholder="Passphrase" /></div>
          <div className="field"><label>Passphrase bestätigen</label>
            <input type="password" value={initPass2} onChange={(e) => setInitPass2(e.target.value)} placeholder="Wiederholen" /></div>
          <button className="btn primary" disabled={busy} onClick={init}>Tresor initialisieren</button>
        </div>
      ) : (<>
        <div className="pill-group" style={{ marginBottom: 12 }}>
          <Badge kind="ok">initialisiert</Badge>
          <Badge kind="info">{status.count} Einträge</Badge>
          {status.createdAt && <span className="help" style={{ fontSize: 12 }}>angelegt {ago(status.createdAt)}</span>}
        </div>

        <div className="field" style={{ maxWidth: 480 }}>
          <label>Tresor-Passphrase (für Speichern / Wiederherstellen / Export-Zusammenführen)</label>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Passphrase eingeben" />
        </div>

        {/* Add entry */}
        <div className="section" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Secret hinzufügen / aktualisieren</div>
          <div className="form-grid">
            <div className="field"><label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. db_password" /></div>
          </div>
          <div className="field"><label>Wert</label>
            <textarea rows={3} value={value} onChange={(e) => setValue(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} placeholder="Geheimwert…" /></div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginBottom: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={alsoDocker} onChange={(e) => setAlsoDocker(e.target.checked)} />
            Zusätzlich sofort als Docker-Secret anlegen
          </label>
          <button className="btn primary" disabled={busy} onClick={addEntry}>Speichern</button>
        </div>

        {/* Entries */}
        <div className="section" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Gespeicherte Secrets ({status.count})</div>
          {status.entries.length === 0 ? <div className="help">Noch keine Einträge.</div> : (
            <table>
              <thead><tr><th>Name</th><th>Labels</th><th>Aktualisiert</th><th>Aktion</th></tr></thead>
              <tbody>
                {status.entries.map((e) => (
                  <tr key={e.name}>
                    <td className="mono" style={{ fontWeight: 600 }}>{e.name}</td>
                    <td>{Object.keys(e.labels || {}).length ? <div className="pill-group">{Object.entries(e.labels).map(([k, v]) => <Badge key={k} kind="muted">{k}={v}</Badge>)}</div> : <span className="help">–</span>}</td>
                    <td>{e.updatedAt ? ago(e.updatedAt) : '–'}</td>
                    <td><button className="btn sm danger" onClick={() => delEntry(e.name)}>Entfernen</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Export / Import */}
        <div className="section" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Export / Import</div>
          <div className="help" style={{ marginBottom: 8 }}>Der Export ist bereits verschlüsselt (die Passphrase steckt nicht darin). Bewahren Sie ihn getrennt vom zentralen Backup auf.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn" onClick={exportVault}>⬇ Verschlüsselt exportieren</button>
            <span style={{ width: 1, height: 22, background: 'var(--border)' }} />
            <label className="help" style={{ margin: 0 }}>Import-Modus:</label>
            <select value={importMode} onChange={(e) => setImportMode(e.target.value)} style={{ width: 160 }}>
              <option value="merge">Zusammenführen</option>
              <option value="replace">Ersetzen</option>
            </select>
            <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={(e) => doImport(e.target.files?.[0])} />
            <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>⬆ Importieren…</button>
          </div>
        </div>

        {/* Recreate in Docker */}
        <div className="section" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Docker-Secrets wiederherstellen</div>
          <div className="help" style={{ marginBottom: 8 }}>Legt die im Tresor gespeicherten Werte (entschlüsselt mit der Passphrase oben) als Docker-Secrets an.</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginBottom: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} />
            Bestehende gleichnamige Secrets ersetzen (nur wenn nicht in Verwendung)
          </label>
          <button className="btn primary" disabled={busy} onClick={recreate}>Alle Secrets wiederherstellen</button>
          {recResult && (
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>Name</th><th>Ergebnis</th></tr></thead>
              <tbody>
                {recResult.map((r) => (
                  <tr key={r.name}>
                    <td className="mono">{r.name}</td>
                    <td>{r.ok ? <Badge kind="ok">angelegt</Badge> : r.skipped ? <Badge kind="muted">{r.error}</Badge> : <><Badge kind="err">Fehler</Badge> <span className="help">{r.error}</span></>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Danger zone */}
        <div className="section" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" disabled={busy} onClick={changePass}>Passphrase ändern</button>
            <button className="btn danger" onClick={destroy}>Tresor löschen</button>
          </div>
        </div>
      </>)}
    </div>
  );
}
