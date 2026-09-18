import { useState, useRef } from 'react';
import { api } from '../api.js';
import { useApi } from '../components/useApi.js';
import { Badge, Modal, useToast, ago } from '../components/ui.jsx';
import CodeEditor from '../components/CodeEditor.jsx';
import StackDetailModal from '../components/StackDetailModal.jsx';

const SAMPLE = `version: "3.8"
services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
    deploy:
      replicas: 2
      restart_policy:
        condition: on-failure
`;

function download(path) {
  const a = document.createElement('a');
  a.href = `/api${path}`;
  document.body.appendChild(a); a.click(); a.remove();
}

export default function Stacks() {
  const { data, error, loading, reload } = useApi('/stacks', { poll: 6000 });
  const { data: saved, reload: reloadSaved } = useApi('/stacks/saved', { poll: 0 });
  const toast = useToast();
  const fileRef = useRef(null);

  const [editor, setEditor] = useState(null); // { name, compose } or null
  const [detailStack, setDetailStack] = useState(null);
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState(null); // { name, deployed, summary, diffs } or null
  const [diffBusy, setDiffBusy] = useState(false);

  const openNew = () => setEditor({ name: '', compose: SAMPLE });
  const openEdit = (s) => setEditor({ name: s.name, compose: s.compose });

  const showDiff = async () => {
    if (!editor?.name) { toast('Stack-Name erforderlich', 'err'); return; }
    setDiffBusy(true);
    try {
      const r = await api.post(`/stacks/${editor.name}/diff`, { compose: editor.compose });
      setDiff(r);
    } catch (e) { toast(e.message, 'err'); } finally { setDiffBusy(false); }
  };

  const deploy = async (alsoSave) => {
    setBusy(true);
    try {
      const r = await api.post('/stacks/deploy', { name: editor.name, compose: editor.compose, save: alsoSave });
      toast(`Stack "${editor.name}" deployed`);
      if (r.output) console.log(r.output);
      setEditor(null); reload(); reloadSaved();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const saveOnly = async () => {
    setBusy(true);
    try {
      await api.put('/stacks/saved', { name: editor.name, compose: editor.compose });
      toast(`Stack "${editor.name}" gespeichert (ohne Deploy)`);
      setEditor(null); reloadSaved();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const removeDeployed = async (n) => {
    if (!confirm(`Stack "${n}" und alle zugehörigen Objekte entfernen?`)) return;
    try { await api.del(`/stacks/${n}`); toast(`Stack "${n}" entfernt`); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const editDeployed = async (n) => {
    try {
      const r = await api.get(`/stacks/${n}/compose`);
      setEditor({ name: n, compose: r.compose });
      toast(r.source === 'saved' ? 'Gespeicherte Definition geladen' : 'Aus laufendem Stack rekonstruiert (best effort)');
    } catch (e) { toast(e.message, 'err'); }
  };

  const copyToTemplate = async (n) => {
    try {
      const r = await api.get(`/stacks/${n}/compose`);
      await api.put('/stacks/saved', { name: n, compose: r.compose });
      toast(`Stack "${n}" als Template gespeichert`);
      reloadSaved();
    } catch (e) { toast(e.message, 'err'); }
  };

  const deleteSaved = async (n) => {
    if (!confirm(`Gespeicherte Definition "${n}" löschen?`)) return;
    try { await api.del(`/stacks/saved/${n}`); toast('Definition gelöscht'); reloadSaved(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const name = file.name.replace(/\.(ya?ml)$/i, '').replace(/[^a-zA-Z0-9_.-]/g, '-');
    setEditor({ name, compose: text });
    toast('Compose importiert — prüfen und speichern/deployen');
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Stacks</h1><div className="sub">Compose-basierte Deployments & gespeicherte Definitionen</div></div>
        <div className="actions">
          <button className="btn" onClick={reload}>↻</button>
          <input type="file" ref={fileRef} accept=".yml,.yaml" style={{ display: 'none' }} onChange={onImport} />
          <button className="btn" onClick={() => fileRef.current?.click()}>⬆ Import</button>
          <button className="btn primary" onClick={openNew}>+ Neuer Stack</button>
        </div>
      </div>

      {error && <div className="banner">{error}</div>}
      {loading && !data && <div className="spinner">Lade Stacks…</div>}

      <h2 style={{ fontSize: 15, margin: '4px 0 10px' }}>Deployt im Swarm</h2>
      {data && data.length === 0 && <div className="empty" style={{ padding: 24 }}>Keine Stacks deployed.</div>}
      {data && data.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 24 }}>
          <table>
            <thead><tr><th>Name</th><th>Services</th><th>Tasks laufend</th><th>Aktionen</th></tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.name}>
                  <td style={{ fontWeight: 600 }}><span style={{ cursor: 'pointer' }} onClick={() => setDetailStack(s.name)} title="Details anzeigen"><Badge kind="info">{s.name} ▸</Badge></span></td>
                  <td>{s.services}</td>
                  <td>{s.tasksRunning}</td>
                  <td>
                    <div className="actions">
                      <button className="btn sm" onClick={() => editDeployed(s.name)}>Bearbeiten</button>
                      <button className="btn sm" onClick={() => copyToTemplate(s.name)}>Als Template</button>
                      <button className="btn sm danger" onClick={() => removeDeployed(s.name)}>Entfernen</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ fontSize: 15, margin: '4px 0 10px' }}>Templates (zentrale Vorlagen)</h2>
      <div className="help" style={{ marginBottom: 8 }}>
        Gespeicherte Definitionen dienen als zentrale Vorlage. „Bearbeiten" öffnet sie im Editor — mit
        „Speichern &amp; Deployen" wird der laufende Stack aus der Vorlage neu bereitgestellt.
      </div>
      {(!saved || saved.length === 0)
        ? <div className="empty" style={{ padding: 24 }}>Keine Templates. „Als Template" bei einem laufenden Stack oder „Neuer Stack" → „Speichern".</div>
        : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Gespeichert</th><th>Aktionen</th></tr></thead>
              <tbody>
                {saved.map((s) => (
                  <tr key={s.name}>
                    <td style={{ fontWeight: 600 }}><Badge kind="muted">{s.name}</Badge></td>
                    <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>{ago(s.savedAt)}</td>
                    <td>
                      <div className="actions">
                        <button className="btn sm" onClick={() => openEdit(s)}>Bearbeiten / Deployen</button>
                        <button className="btn sm" onClick={() => download(`/stacks/saved/${s.name}/export`)}>Export</button>
                        <button className="btn sm danger" onClick={() => deleteSaved(s.name)}>Löschen</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {editor && (
        <Modal wide title={editor.name ? `Stack · ${editor.name}` : 'Neuer Stack'} onClose={() => setEditor(null)}
          footer={<>
            <button className="btn" onClick={() => setEditor(null)}>Abbrechen</button>
            <button className="btn" disabled={diffBusy || !editor.name} onClick={showDiff}>{diffBusy ? 'Prüfe…' : '≠ Diff anzeigen'}</button>
            <button className="btn" disabled={busy || !editor.name} onClick={saveOnly}>Speichern ohne Deploy</button>
            <button className="btn" disabled={busy || !editor.name} onClick={() => deploy(true)}>Speichern & Deployen</button>
            <button className="btn primary" disabled={busy || !editor.name} onClick={() => deploy(false)}>Deployen</button>
          </>}>
          <div className="field">
            <label>Stack-Name</label>
            <input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} placeholder="mein-stack" />
          </div>
          <div className="field">
            <label>docker-compose.yml</label>
            <CodeEditor value={editor.compose} onChange={(v) => setEditor({ ...editor, compose: v })} minHeight={340} />
          </div>
          <p className="help">Deploy erfordert die Docker-CLI im Backend-Container. „Speichern" legt die Definition ohne Deploy ab.</p>
        </Modal>
      )}
      {diff && (
        <Modal wide title={`Diff · ${diff.name}`} onClose={() => setDiff(null)}
          footer={<button className="btn" onClick={() => setDiff(null)}>Schließen</button>}>
          {!diff.deployed && <div className="banner" style={{ marginBottom: 10 }}>Stack ist noch nicht deployt — alle Dienste werden neu erstellt.</div>}
          <div className="help" style={{ marginBottom: 10 }}>
            <Badge kind="ok">{diff.summary.added} neu</Badge>{' '}
            <Badge kind="warn">{diff.summary.changed} geändert</Badge>{' '}
            <Badge kind="err">{diff.summary.removed} entfernt</Badge>{' '}
            <Badge kind="muted">{diff.summary.unchanged} unverändert</Badge>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Service</th><th>Änderung</th><th>Details</th></tr></thead>
              <tbody>
                {diff.diffs.map((d) => (
                  <tr key={d.service}>
                    <td style={{ fontWeight: 600 }}>{d.service}</td>
                    <td><Badge kind={d.change === 'added' ? 'ok' : d.change === 'removed' ? 'err' : d.change === 'changed' ? 'warn' : 'muted'}>{d.change}</Badge></td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {d.fields.length === 0 ? '–' : d.fields.map((f) => (
                        <div key={f.field}>
                          <b>{f.field}:</b> <span style={{ color: 'var(--red)' }}>{JSON.stringify(f.from)}</span> → <span style={{ color: 'var(--green,#3fb950)' }}>{JSON.stringify(f.to)}</span>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
      {detailStack && <StackDetailModal name={detailStack} onClose={() => setDetailStack(null)} />}
    </>
  );
}
