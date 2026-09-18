import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from './useApi.js';
import { Badge, Modal, useToast } from './ui.jsx';

const typeBadge = (t) => {
  if (t === 'swarm') return <Badge kind="info">Swarm</Badge>;
  if (t === 'swarm-worker') return <Badge kind="muted">Swarm-Worker</Badge>;
  if (t === 'standalone') return <Badge kind="ok">Standalone</Badge>;
  return <Badge kind="muted">{t || '?'}</Badge>;
};

const EMPTY = {
  name: '', kind: 'tcp', host: '', port: '', username: '',
  password: '', privateKey: '', ca: '', cert: '', key: '',
  tags: '', readOnly: false, allowInsecure: false,
};

function EndpointForm({ onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  const set = (patch) => setF({ ...f, ...patch });

  const buildConn = () => {
    const conn = { kind: f.kind, host: f.host.trim(), port: f.port ? Number(f.port) : undefined };
    if (f.kind === 'ssh') {
      if (f.username) conn.username = f.username.trim();
      if (f.password) conn.password = f.password;
      if (f.privateKey) conn.privateKey = f.privateKey;
    } else {
      if (f.ca || f.cert || f.key) conn.tls = { ca: f.ca || undefined, cert: f.cert || undefined, key: f.key || undefined };
    }
    return conn;
  };

  const runTest = async () => {
    setBusy(true); setTest(null);
    try {
      const r = await api.post('/endpoints/test', { conn: buildConn() });
      setTest(r);
      if (!r.ok) toast(r.error || 'Verbindung fehlgeschlagen', 'err');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const save = async () => {
    if (!f.name.trim()) { toast('Name erforderlich', 'err'); return; }
    if (!f.host.trim()) { toast('Host erforderlich', 'err'); return; }
    setBusy(true);
    try {
      await api.post('/endpoints', {
        name: f.name.trim(),
        tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
        readOnly: f.readOnly,
        allowInsecure: f.allowInsecure,
        conn: buildConn(),
      });
      toast(`Endpoint „${f.name}" hinzugefügt`);
      onSaved(); onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal wide title="🖥 Docker-Endpoint hinzufügen" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Abbrechen</button>
        <button className="btn" disabled={busy} onClick={runTest}>Verbindung testen</button>
        <button className="btn primary" disabled={busy} onClick={save}>＋ Hinzufügen</button>
      </>}>
      <div className="field">
        <label>Name <span style={{ color: 'var(--red)' }}>*</span></label>
        <input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="z. B. Prod-Swarm-B oder Host-Edge01" autoFocus />
      </div>
      <div className="field">
        <label>Verbindungstyp</label>
        <select value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
          <option value="tcp">TCP (Docker API, empfohlen mit TLS)</option>
          <option value="ssh">SSH</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div className="field" style={{ flex: 2 }}>
          <label>Host <span style={{ color: 'var(--red)' }}>*</span></label>
          <input value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder={f.kind === 'ssh' ? 'edge01.example.com' : '10.0.0.5'} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Port</label>
          <input value={f.port} onChange={(e) => set({ port: e.target.value })} placeholder={f.kind === 'ssh' ? '22' : '2376'} />
        </div>
      </div>

      {f.kind === 'ssh' ? (
        <>
          <div className="field">
            <label>SSH-Benutzer</label>
            <input value={f.username} onChange={(e) => set({ username: e.target.value })} placeholder="root" />
          </div>
          <div className="field">
            <label>Passwort (optional)</label>
            <input type="password" value={f.password} onChange={(e) => set({ password: e.target.value })} placeholder="•••" />
          </div>
          <div className="field">
            <label>Privater Schlüssel (optional, PEM)</label>
            <textarea rows={3} value={f.privateKey} onChange={(e) => set({ privateKey: e.target.value })} style={{ fontFamily: 'monospace', fontSize: 11 }} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          </div>
        </>
      ) : (
        <>
          <div className="help" style={{ marginBottom: 8 }}>TLS-Client-Zertifikate (empfohlen). Ohne TLS ist nur Port 2376 mit Zertifikaten oder – ausdrücklich – unverschlüsseltes 2375 möglich.</div>
          <div className="field">
            <label>CA-Zertifikat (ca.pem)</label>
            <textarea rows={2} value={f.ca} onChange={(e) => set({ ca: e.target.value })} style={{ fontFamily: 'monospace', fontSize: 11 }} placeholder="-----BEGIN CERTIFICATE-----" />
          </div>
          <div className="field">
            <label>Client-Zertifikat (cert.pem)</label>
            <textarea rows={2} value={f.cert} onChange={(e) => set({ cert: e.target.value })} style={{ fontFamily: 'monospace', fontSize: 11 }} placeholder="-----BEGIN CERTIFICATE-----" />
          </div>
          <div className="field">
            <label>Client-Schlüssel (key.pem)</label>
            <textarea rows={2} value={f.key} onChange={(e) => set({ key: e.target.value })} style={{ fontFamily: 'monospace', fontSize: 11 }} placeholder="-----BEGIN PRIVATE KEY-----" />
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={f.allowInsecure} onChange={(e) => set({ allowInsecure: e.target.checked })} />
            Unverschlüsselten Port 2375 ausdrücklich erlauben (nicht empfohlen)
          </label>
        </>
      )}

      <div className="field">
        <label>Tags (kommagetrennt)</label>
        <input value={f.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="prod, region-eu, edge" />
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={f.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} />
        Read-only (Schreibaktionen für diesen Endpoint sperren)
      </label>

      {test && (
        <div className="banner" style={{ background: test.ok ? 'rgba(63,185,80,.12)' : undefined }}>
          {test.ok
            ? <>✓ Verbunden: <b>{test.hostname}</b> · Docker {test.version} · {typeBadge(test.type)} {test.nodes != null ? `· ${test.nodes} Node(s)` : ''}</>
            : <>✗ {test.error}</>}
        </div>
      )}
    </Modal>
  );
}

export default function EndpointsSection() {
  const toast = useToast();
  const { data, loading, reload } = useApi('/endpoints', { poll: 0 });
  const [adding, setAdding] = useState(false);
  const [tagEdit, setTagEdit] = useState(null); // { id, name, tags }
  const [busy, setBusy] = useState(false);

  const testOne = async (ep) => {
    try { const r = await api.post(`/endpoints/${ep.id}/test`); toast(r.ok ? `${ep.name}: erreichbar (Docker ${r.version})` : `${ep.name}: ${r.error}`, r.ok ? 'ok' : 'err'); }
    catch (e) { toast(e.message, 'err'); }
  };

  const del = async (ep) => {
    if (!window.confirm(`Endpoint „${ep.name}" entfernen?`)) return;
    try { await api.del(`/endpoints/${ep.id}`); toast('Endpoint entfernt'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const saveTags = async () => {
    setBusy(true);
    try {
      await api.put(`/endpoints/${tagEdit.id}`, { tags: tagEdit.tags.split(',').map((t) => t.trim()).filter(Boolean) });
      toast('Tags gespeichert'); setTagEdit(null); reload();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div><h2 style={{ margin: 0 }}>Docker-Endpoints</h2>
          <div className="help">Weitere Standalone-Hosts oder Swarm-Cluster hinzufügen. Sie erscheinen gruppiert im Bereich Nodes.</div>
        </div>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setAdding(true)}>＋ Endpoint hinzufügen</button>
      </div>
      {loading && !data && <div className="spinner">Lade…</div>}
      {data && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Typ</th><th>Verbindung</th><th>Tags</th><th>Aktion</th></tr></thead>
            <tbody>
              {data.map((ep) => (
                <tr key={ep.id}>
                  <td style={{ fontWeight: 600 }}>{ep.name} {ep.builtin && <Badge kind="muted">lokal</Badge>} {ep.readOnly && <Badge kind="warn">read-only</Badge>}</td>
                  <td>{typeBadge(ep.type)}</td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {ep.builtin ? 'Socket (lokal)' : `${ep.conn.kind}://${ep.conn.host}:${ep.conn.port}`}
                    {ep.conn?.hasTls && <> <Badge kind="ok">TLS</Badge></>}
                  </td>
                  <td>{(ep.tags || []).length ? ep.tags.map((t) => <Badge key={t} kind="info">{t}</Badge>) : <span className="help">–</span>}</td>
                  <td>
                    <div className="actions">
                      <button className="btn sm" onClick={() => testOne(ep)}>Test</button>
                      <button className="btn sm" onClick={() => setTagEdit({ id: ep.id, name: ep.name, tags: (ep.tags || []).join(', ') })}>Tags</button>
                      {!ep.builtin && <button className="btn sm danger" onClick={() => del(ep)}>Entfernen</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && <EndpointForm onClose={() => setAdding(false)} onSaved={reload} />}
      {tagEdit && (
        <Modal title={`Tags · ${tagEdit.name}`} onClose={() => setTagEdit(null)}
          footer={<>
            <button className="btn" onClick={() => setTagEdit(null)}>Abbrechen</button>
            <button className="btn primary" disabled={busy} onClick={saveTags}>Speichern</button>
          </>}>
          <div className="field">
            <label>Tags (kommagetrennt)</label>
            <input value={tagEdit.tags} onChange={(e) => setTagEdit({ ...tagEdit, tags: e.target.value })} placeholder="prod, region-eu" autoFocus />
          </div>
        </Modal>
      )}
    </div>
  );
}
