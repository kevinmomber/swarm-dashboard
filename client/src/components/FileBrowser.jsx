import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { bytes, useToast } from './ui.jsx';

const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentOf = (p) => { if (p === '/' || !p) return '/'; const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };

/** File browser inside a container/service (exec-based) or a named volume. */
export default function FileBrowser({ nodeId, containerId, volume, editable = true }) {
  const toast = useToast();
  const [path, setPath] = useState('/');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null); // { name, path, text }
  const fileInput = useRef(null);

  const scope = volume
    ? { listUrl: (p) => `/volumes/fs/list?nodeId=${encodeURIComponent(nodeId || '')}&volume=${encodeURIComponent(volume)}&path=${encodeURIComponent(p)}`,
        readUrl: (p) => `/volumes/fs/read?nodeId=${encodeURIComponent(nodeId || '')}&volume=${encodeURIComponent(volume)}&path=${encodeURIComponent(p)}`,
        opBody: (opName, p, contentB64) => ({ nodeId, volume, op: opName, path: p, contentB64 }),
        opUrl: '/volumes/fs/op' }
    : { listUrl: (p) => `/containers/fs/list?nodeId=${encodeURIComponent(nodeId || '')}&id=${encodeURIComponent(containerId)}&path=${encodeURIComponent(p)}`,
        readUrl: (p) => `/containers/fs/read?nodeId=${encodeURIComponent(nodeId || '')}&id=${encodeURIComponent(containerId)}&path=${encodeURIComponent(p)}`,
        opBody: (opName, p, contentB64) => ({ nodeId, id: containerId, op: opName, path: p, contentB64 }),
        opUrl: '/containers/fs/op' };

  const load = (p) => {
    setData(null); setErr(null);
    api.get(scope.listUrl(p))
      .then((d) => { setData(d); setPath(d.path); })
      .catch((e) => setErr(e.message));
  };
  useEffect(() => { load('/'); /* eslint-disable-next-line */ }, [nodeId, containerId, volume]);

  const op = async (opName, p, contentB64) => {
    setBusy(true);
    try {
      await api.post(scope.opUrl, scope.opBody(opName, p, contentB64));
      load(path);
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const enter = (e) => {
    if (e.type === 'dir') load(joinPath(path, e.name));
    else if (e.type === 'symlink' && e.link) {
      const target = e.link.startsWith('/') ? e.link : joinPath(path, e.link);
      load(target); // best effort; if it's a file the list will error
    }
  };

  const del = (e) => { if (confirm(`"${e.name}" löschen?`)) op('delete', joinPath(path, e.name)); };
  const mkdir = () => { const n = prompt('Ordnername:'); if (n) op('mkdir', joinPath(path, n.trim())); };
  const newFile = () => { const n = prompt('Dateiname:'); if (n) op('newfile', joinPath(path, n.trim())); };

  const readFile = async (e) => {
    const r = await api.get(scope.readUrl(joinPath(path, e.name)));
    return r;
  };

  const openEdit = async (e) => {
    try {
      const r = await readFile(e);
      const bin = atob(r.base64);
      // treat as text if no NUL byte in first bytes
      if (bin.slice(0, 4096).includes('\u0000')) { toast('Binärdatei — nur Download möglich', 'err'); return; }
      let txt = ''; for (let i = 0; i < bin.length; i++) txt += bin[i];
      try { txt = decodeURIComponent(escape(txt)); } catch { /* keep raw */ }
      setEdit({ name: e.name, path: joinPath(path, e.name), text: txt, truncated: r.truncated });
    } catch (ex) { toast(ex.message, 'err'); }
  };

  const saveEdit = async () => {
    let bin; try { bin = unescape(encodeURIComponent(edit.text)); } catch { bin = edit.text; }
    let b = ''; for (let i = 0; i < bin.length; i++) b += bin[i];
    await op('write', edit.path, btoa(b));
    toast(`„${edit.name}" gespeichert`);
    setEdit(null);
  };

  const download = async (e) => {
    try {
      const r = await readFile(e);
      const bin = atob(r.base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = e.name;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      if (r.truncated) toast('Datei gekürzt (max 1 MB)', 'err');
    } catch (ex) { toast(ex.message, 'err'); }
  };

  const onUpload = async (ev) => {
    const f = ev.target.files?.[0];
    ev.target.value = '';
    if (!f) return;
    const buf = await f.arrayBuffer();
    let bin = ''; const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    await op('write', joinPath(path, f.name), btoa(bin));
    toast(`„${f.name}" hochgeladen`);
  };

  const segments = path === '/' ? [] : path.split('/').filter(Boolean);

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 8, gap: 8 }}>
        <button className="btn sm" disabled={path === '/'} onClick={() => load(parentOf(path))}>‹ Zurück</button>
        <button className="btn sm" onClick={() => load('/')}>⌂</button>
        <span className="mono" style={{ color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>
          /{segments.map((s, i) => {
            const p = '/' + segments.slice(0, i + 1).join('/');
            return <span key={i}><a style={{ cursor: 'pointer' }} onClick={() => load(p)}>{s}</a>{i < segments.length - 1 ? '/' : ''}</span>;
          })}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn sm" disabled={busy} onClick={newFile} title="Neue Datei">🖹＋</button>
          <button className="btn sm" disabled={busy} onClick={mkdir} title="Neuer Ordner">🗀＋</button>
          <button className="btn sm" disabled={busy} onClick={() => fileInput.current?.click()} title="Hochladen">⭱</button>
          <button className="btn sm" onClick={() => load(path)} title="Aktualisieren">↻</button>
          <input ref={fileInput} type="file" style={{ display: 'none' }} onChange={onUpload} />
        </div>
      </div>
      {err && <div className="banner">{err}</div>}
      {!data && !err && <div className="help">Lade…</div>}
      {data && (
        <div className="table-wrap" style={{ maxHeight: '46vh', overflow: 'auto' }}>
          <table>
            <thead><tr><th>Name</th><th>Größe</th><th>Rechte</th><th>Owner</th><th>Geändert</th><th></th></tr></thead>
            <tbody>
              {data.entries.length === 0 && <tr><td colSpan={6} className="help" style={{ padding: 16 }}>Leeres Verzeichnis.</td></tr>}
              {data.entries.map((e) => (
                <tr key={e.name}>
                  <td>
                    <span
                      style={{ cursor: e.type === 'dir' || e.type === 'symlink' ? 'pointer' : 'default', color: e.type === 'symlink' ? 'var(--purple, #a78bfa)' : undefined }}
                      onClick={() => (e.type === 'dir' || e.type === 'symlink') && enter(e)}
                    >
                      {e.type === 'dir' ? '🗀' : e.type === 'symlink' ? '🔗' : '🖹'} {e.name}
                      {e.link && <span className="help"> → {e.link}</span>}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.size == null ? '–' : bytes(e.size)}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.octal} <span style={{ color: 'var(--text-dim)' }}>{e.perms}</span></td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.owner}</td>
                  <td className="help" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{e.modified}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {e.type === 'file' && editable && <button className="btn sm" disabled={busy} onClick={() => openEdit(e)} title="Bearbeiten">✎</button>}
                    {e.type === 'file' && <button className="btn sm" disabled={busy} onClick={() => download(e)} title="Herunterladen">⭳</button>}
                    <button className="btn sm danger" disabled={busy} onClick={() => del(e)} title="Löschen">🗑</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(1,4,9,.6)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 24 }} onClick={() => setEdit(null)}>
          <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 10, width: '100%', maxWidth: 820, maxHeight: '86vh', display: 'flex', flexDirection: 'column' }} onClick={(ev) => ev.stopPropagation()}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <b className="mono" style={{ fontSize: 13 }}>{edit.path}</b>
              <button className="x-btn" onClick={() => setEdit(null)}>×</button>
            </div>
            <div style={{ padding: 12, overflow: 'auto' }}>
              {edit.truncated && <div className="help" style={{ marginBottom: 6, color: 'var(--amber)' }}>⚠ Datei &gt; 1 MB — gekürzt, Speichern würde abschneiden. Bitte via Download bearbeiten.</div>}
              <textarea value={edit.text} onChange={(ev) => setEdit({ ...edit, text: ev.target.value })} spellCheck={false}
                style={{ width: '100%', height: '58vh', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }} />
            </div>
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
              <button className="btn primary" disabled={busy || edit.truncated} onClick={saveEdit}>Speichern</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
