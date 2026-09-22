import { useState, useRef } from 'react';
import { api } from '../api.js';
import { useApi } from '../components/useApi.js';
import { Badge, Modal, bytes, ago, short, useToast } from '../components/ui.jsx';
import TabBar from '../components/TabBar.jsx';
import BuilderPanel from '../components/BuilderPanel.jsx';
import ImagePullPanel from '../components/ImagePullPanel.jsx';

function download(path) {
  const a = document.createElement('a');
  a.href = `/api${path}`;
  document.body.appendChild(a); a.click(); a.remove();
}

function Library() {
  const { data, error, loading, reload } = useApi('/images', { poll: 10000 });
  const { data: nodesData } = useApi('/nodes', { poll: 0 });
  const toast = useToast();
  const [node, setNode] = useState('all');
  const [q, setQ] = useState('');
  const [usageFilter, setUsageFilter] = useState('all'); // all | used | unused
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [progress, setProgress] = useState(null); // { total, done, current, results:[] }
  const [confirmDel, setConfirmDel] = useState(null); // { targets:[im...] }
  const [delChk, setDelChk] = useState(false);
  const [usageFor, setUsageFor] = useState(null); // im whose usage modal is open
  const [usageData, setUsageData] = useState(null);
  const [usageErr, setUsageErr] = useState(null);
  const [upload, setUpload] = useState(null); // { file, nodes:Set, results:[], busy }
  const fileRef = useRef(null);

  const nodes = [...new Set((data || []).map((i) => i.node).filter(Boolean))].sort();
  const rows = (data || [])
    .filter((i) => node === 'all' || i.node === node)
    .filter((i) => usageFilter === 'all' || (usageFilter === 'unused' ? !i.inUse : i.inUse))
    .filter((i) => {
      if (!q) return true;
      const t = q.toLowerCase();
      return i.repoTags.some((x) => x.toLowerCase().includes(t)) || i.id.toLowerCase().includes(t);
    });
  const refOf = (im) => im.repoTags[0] || im.id;
  const keyOf = (im) => `${im.nodeId}|${im.id}`;

  const toggle = (im) => {
    const k = keyOf(im);
    const next = new Set(selected);
    next.has(k) ? next.delete(k) : next.add(k);
    setSelected(next);
  };
  const allVisibleSelected = rows.length > 0 && rows.every((im) => selected.has(keyOf(im)));
  const toggleAll = () => {
    if (allVisibleSelected) setSelected(new Set());
    else setSelected(new Set(rows.map(keyOf)));
  };

  const openUsage = (im) => {
    setUsageErr(null); setUsageData(null); setUsageFor(im);
    api.get(`/images/usage?nodeId=${encodeURIComponent(im.nodeId)}&id=${encodeURIComponent(im.id)}&ref=${encodeURIComponent(refOf(im))}`)
      .then(setUsageData).catch((e) => setUsageErr(e.message));
  };
  const closeUsage = () => { setUsageFor(null); setUsageData(null); setUsageErr(null); };

  // Unified delete: single row or bulk selection, always via a checkbox confirm.
  const askDelete = (targets) => { if (targets.length) { setDelChk(false); setConfirmDel({ targets }); } };
  const runDelete = async () => {
    const targets = confirmDel.targets;
    setConfirmDel(null);
    setBusy(true);
    setProgress({ total: targets.length, done: 0, current: '', results: [] });
    const results = [];
    for (let i = 0; i < targets.length; i++) {
      const im = targets[i];
      const ref = refOf(im);
      setProgress({ total: targets.length, done: i, current: ref, results: [...results] });
      try {
        await api.post('/images/action', { nodeId: im.nodeId, id: ref, action: 'remove', force: im.inUse });
        results.push({ ref, ok: true });
      } catch (e) {
        results.push({ ref, ok: false, error: e.message });
      }
    }
    setProgress({ total: targets.length, done: targets.length, current: '', results });
    setSelected(new Set());
    setBusy(false);
    const okCount = results.filter((r) => r.ok).length;
    toast(`${okCount}/${targets.length} Images gelöscht`, okCount === targets.length ? 'ok' : 'err');
    reload();
  };

  const prune = async () => {
    const target = node === 'all' ? null : (data.find((i) => i.node === node)?.nodeId);
    if (!confirm('Ungenutzte (dangling) Images aufräumen?')) return;
    setBusy(true);
    try {
      const r = await api.post('/images/prune', { nodeId: target, all: false });
      toast(`Aufgeräumt: ${r.deleted} Images, ${bytes(r.reclaimed)} frei`); reload();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const exportImg = (im) => { toast('Download wird vorbereitet…'); download(`/images/export?nodeId=${encodeURIComponent(im.nodeId)}&image=${encodeURIComponent(refOf(im))}`); };

  const clusterNodes = (nodesData || []).filter((n) => n.state === 'ready' || !n.state);

  // Open the upload modal; preselect the currently filtered node, else all nodes.
  const openUpload = (file) => {
    const preset = node === 'all'
      ? new Set(clusterNodes.map((n) => n.id))
      : new Set(clusterNodes.filter((n) => n.hostname === node).map((n) => n.id));
    setUpload({ file, nodes: preset, results: null, busy: false });
  };
  const onUpload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    openUpload(file);
  };
  const toggleUploadNode = (id) => setUpload((u) => {
    const n = new Set(u.nodes); n.has(id) ? n.delete(id) : n.add(id); return { ...u, nodes: n };
  });
  const runUpload = async () => {
    const ids = [...upload.nodes];
    if (ids.length === 0) { toast('Mindestens einen Node wählen', 'err'); return; }
    setUpload((u) => ({ ...u, busy: true, results: null }));
    try {
      const res = await fetch(`/api/images/import-multi?nodeIds=${encodeURIComponent(ids.join(','))}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-tar' }, body: upload.file,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const nameById = new Map(clusterNodes.map((n) => [n.id, n.hostname]));
      const results = (j.results || []).map((r) => ({ ...r, node: nameById.get(r.nodeId) || r.nodeId }));
      setUpload((u) => ({ ...u, busy: false, results }));
      const ok = results.filter((r) => r.ok).length;
      toast(`Upload: ${ok}/${results.length} Nodes erfolgreich`, ok === results.length ? 'ok' : 'err');
      reload();
    } catch (e2) {
      setUpload((u) => ({ ...u, busy: false }));
      toast(e2.message, 'err');
    }
  };

  const selCount = selected.size;

  return (
    <>
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <div className="sub">Alle Images im Swarm, je Node</div>
        <button className="btn" onClick={reload}>↻ Aktualisieren</button>
      </div>

      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <label style={{ margin: 0 }}>Node:</label>
        <select style={{ width: 180 }} value={node} onChange={(e) => setNode(e.target.value)}>
          <option value="all">Alle Nodes</option>
          {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <input style={{ maxWidth: 240 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Image nach Name filtern…" />
        {q && <button className="btn sm" onClick={() => setQ('')}>✕</button>}
        <label style={{ margin: '0 0 0 6px' }}>Verwendung:</label>
        <select style={{ width: 160 }} value={usageFilter} onChange={(e) => setUsageFilter(e.target.value)}>
          <option value="all">Alle</option>
          <option value="used">In Verwendung</option>
          <option value="unused">Ungenutzt</option>
        </select>
        <div className="spacer" />
        {selCount > 0 && <button className="btn danger" disabled={busy} onClick={() => askDelete((data || []).filter((im) => selected.has(keyOf(im))))}>{selCount} löschen</button>}
        <input type="file" ref={fileRef} accept=".tar" style={{ display: 'none' }} onChange={onUpload} />
        <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}
          title="Image-Tarball auf einen oder mehrere Nodes laden">⬆ Image hochladen</button>
        <button className="btn danger" disabled={busy} onClick={prune}>Ungenutzte aufräumen</button>
      </div>

      {error && <div className="banner">{error}</div>}
      {loading && !data && <div className="spinner">Lade Images…</div>}
      {data && rows.length === 0 && <div className="empty">Keine Images gefunden.</div>}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }}><input type="checkbox" style={{ width: 'auto' }} checked={allVisibleSelected} onChange={toggleAll} /></th>
                <th>Repository:Tag</th><th>Node</th><th>Größe</th><th>Verwendung</th><th>Erstellt</th><th>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((im) => (
                <tr key={keyOf(im)} style={selected.has(keyOf(im)) ? { background: 'rgba(47,129,247,.12)' } : undefined}>
                  <td><input type="checkbox" style={{ width: 'auto' }} checked={selected.has(keyOf(im))} onChange={() => toggle(im)} /></td>
                  <td>
                    <span className="link-name" onClick={() => openUsage(im)} title="Verwendung anzeigen">
                      {im.repoTags.length
                        ? im.repoTags.map((t) => <div key={t} className="mono" style={{ fontSize: 12 }}>{t}</div>)
                        : <span className="help">&lt;none&gt; (dangling)</span>}
                    </span>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>{short(im.id.replace('sha256:', ''))}</div>
                  </td>
                  <td><Badge kind="muted">{im.node}</Badge></td>
                  <td className="mono" style={{ fontSize: 12 }}>{bytes(im.size)}</td>
                  <td>
                    {im.inUse
                      ? <span className="link-name" onClick={() => openUsage(im)} title="Verwendung anzeigen"><Badge kind="ok">in Verwendung</Badge></span>
                      : <Badge kind="muted">ungenutzt</Badge>}
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>{im.created ? ago(im.created * 1000) : '–'}</td>
                  <td>
                    <div className="actions">
                      <button className="btn sm" disabled={busy} onClick={() => exportImg(im)}>Download</button>
                      <button className="btn sm danger" disabled={busy} onClick={() => askDelete([im])}>Löschen</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {progress && (
        <Modal title="Images werden gelöscht" onClose={() => progress.done >= progress.total && setProgress(null)}
          footer={progress.done >= progress.total ? <button className="btn" onClick={() => setProgress(null)}>Schließen</button> : null}>
          <div className="help" style={{ marginBottom: 8 }}>
            {progress.done} / {progress.total}{progress.current ? ` · aktuell: ${progress.current}` : ''}
          </div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-elev2)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.round((progress.done / progress.total) * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width .2s' }} />
          </div>
          {progress.results.length > 0 && (
            <div style={{ marginTop: 12, maxHeight: 240, overflow: 'auto' }}>
              {progress.results.map((r, i) => (
                <div key={i} style={{ fontSize: 12, padding: '2px 0' }}>
                  <Badge kind={r.ok ? 'ok' : 'err'}>{r.ok ? 'ok' : 'Fehler'}</Badge>{' '}
                  <span className="mono">{r.ref}</span>{r.error ? ` — ${r.error}` : ''}
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
      {usageFor && (
        <Modal title={`Verwendung · ${refOf(usageFor)}`} onClose={closeUsage}
          footer={<button className="btn" onClick={closeUsage}>Schließen</button>}>
          <div className="help" style={{ marginBottom: 10 }}>Node: {usageFor.node}</div>
          {usageErr && <div className="banner">{usageErr}</div>}
          {!usageData && !usageErr && <div className="help">Lade Verwendung…</div>}
          {usageData && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Services ({usageData.services.length})</div>
              {usageData.services.length === 0
                ? <div className="help" style={{ marginBottom: 12 }}>keine</div>
                : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {usageData.services.map((s) => (
                      <Badge key={s.id} kind="info">{s.name}{s.stack ? ` (${s.stack})` : ''}</Badge>
                    ))}
                  </div>
                )}
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Container ({usageData.containers.length})</div>
              {usageData.containers.length === 0
                ? <div className="help">keine</div>
                : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {usageData.containers.map((c) => (
                      <Badge key={c.id} kind={c.state === 'running' ? 'ok' : 'muted'}>
                        {c.name}{c.swarm && c.service ? ` · ${c.service}` : ''}
                      </Badge>
                    ))}
                  </div>
                )}
              {usageData.services.length === 0 && usageData.containers.length === 0 && (
                <div className="help" style={{ marginTop: 4 }}>Dieses Image wird aktuell von keinem Service oder Container verwendet.</div>
              )}
            </>
          )}
        </Modal>
      )}

      {confirmDel && (
        <Modal title={confirmDel.targets.length === 1 ? 'Image löschen' : `${confirmDel.targets.length} Images löschen`}
          onClose={() => setConfirmDel(null)}
          footer={<>
            <button className="btn" onClick={() => setConfirmDel(null)}>Abbrechen</button>
            <button className="btn danger" disabled={!delChk} onClick={runDelete}>Endgültig löschen</button>
          </>}>
          <div className="help" style={{ marginBottom: 10 }}>
            Folgende Image(s) werden entfernt{confirmDel.targets.some((t) => t.inUse) ? ' — in Verwendung befindliche mit force' : ''}:
          </div>
          <div style={{ maxHeight: 200, overflow: 'auto', marginBottom: 14 }}>
            {confirmDel.targets.map((im) => (
              <div key={keyOf(im)} className="mono" style={{ fontSize: 12, padding: '2px 0' }}>
                {refOf(im)} <span style={{ color: 'var(--text-dim)' }}>· {im.node}</span>
                {im.inUse && <> <Badge kind="ok">in Verwendung</Badge></>}
              </div>
            ))}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={delChk} onChange={(e) => setDelChk(e.target.checked)} />
            Ich bestätige, dass ich diese Image(s) endgültig löschen möchte.
          </label>
        </Modal>
      )}

      {upload && (
        <Modal title="Image hochladen" wide onClose={() => !upload.busy && setUpload(null)}
          footer={<>
            <button className="btn" disabled={upload.busy} onClick={() => setUpload(null)}>Schließen</button>
            <button className="btn primary" disabled={upload.busy || upload.nodes.size === 0} onClick={runUpload}>
              {upload.busy ? 'Lädt…' : `Auf ${upload.nodes.size} Node(s) laden`}
            </button>
          </>}>
          <div className="help" style={{ marginBottom: 10 }}>
            Datei: <span className="mono">{upload.file.name}</span> ({bytes(upload.file.size)}). Ziel-Nodes wählen — der Upload wird einmal übertragen und parallel auf alle verteilt.
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
            <button className="btn sm" disabled={upload.busy} onClick={() => setUpload((u) => ({ ...u, nodes: new Set(clusterNodes.map((n) => n.id)) }))}>Alle</button>
            <button className="btn sm" disabled={upload.busy} onClick={() => setUpload((u) => ({ ...u, nodes: new Set() }))}>Keine</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            {clusterNodes.map((n) => {
              const r = upload.results?.find((x) => x.nodeId === n.id);
              return (
                <label key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={upload.nodes.has(n.id)} disabled={upload.busy} onChange={() => toggleUploadNode(n.id)} />
                  {n.hostname}
                  {n.role === 'manager' && <Badge kind="muted">manager</Badge>}
                  {r && (r.ok ? <Badge kind="ok">✓</Badge> : <Badge kind="err">Fehler</Badge>)}
                </label>
              );
            })}
          </div>
          {upload.results && (
            <div style={{ maxHeight: 160, overflow: 'auto' }}>
              {upload.results.map((r) => (
                <div key={r.nodeId} style={{ fontSize: 12, padding: '2px 0' }}>
                  <b>{r.node}</b>: {r.ok ? <span style={{ color: 'var(--green)' }}>OK</span> : <span style={{ color: 'var(--red)' }}>{r.error}</span>}
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

export default function Images() {
  const [tab, setTab] = useState('library');
  return (
    <>
      <div className="page-head">
        <div><h1>Images</h1><div className="sub">Image-Bibliothek und integrierter Builder (CI/CD)</div></div>
      </div>
      <TabBar
        tabs={[{ k: 'library', label: 'Library' }, { k: 'pull', label: 'Pull (Registry)' }, { k: 'builder', label: 'Builder' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'library' && <Library />}
      {tab === 'pull' && <ImagePullPanel />}
      {tab === 'builder' && <BuilderPanel />}
    </>
  );
}