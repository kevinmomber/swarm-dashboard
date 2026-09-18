import { useState, useEffect, useRef } from 'react';
import { api, postSSE, getToken } from '../api.js';
import { useApi } from '../components/useApi.js';
import { Badge, short, ago, bytes, Modal, useToast, usePersistentState, Copy } from '../components/ui.jsx';
import TabBar from '../components/TabBar.jsx';
import FileBrowser from '../components/FileBrowser.jsx';

const TABS = [
  { key: 'networks', label: 'Netzwerke' },
  { key: 'volumes', label: 'Volumes' },
  { key: 'binds', label: 'Bind-Mounts' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'configs', label: 'Configs' },
];

function NetworkDetail({ net, onClose, onDeleted }) {
  const toast = useToast();
  const [usage, setUsage] = useState(null);
  const [err, setErr] = useState(null);
  const [confirmChk, setConfirmChk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/networks/${net.id}/usage`).then(setUsage).catch((e) => setErr(e.message));
  }, [net.id]);

  const del = async () => {
    setBusy(true);
    try {
      await api.del(`/networks/${net.id}`);
      toast(`Netzwerk "${net.name}" entfernt`);
      onDeleted(); onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Netzwerk · ${net.name}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Schließen</button>
        <button className="btn danger" disabled={busy || !usage?.removable || !confirmChk} onClick={del}>Netzwerk löschen</button>
      </>}>
      {err && <div className="banner">{err}</div>}
      {!usage && !err && <div className="help">Lade Nutzung…</div>}
      {usage && (
        <>
          <table style={{ marginBottom: 12 }}>
            <tbody>
              <tr><td>Driver</td><td className="mono">{usage.driver}</td></tr>
              <tr><td>Scope</td><td className="mono">{usage.scope}</td></tr>
              {usage.ingress && <tr><td>Typ</td><td><Badge kind="info">Ingress</Badge></td></tr>}
            </tbody>
          </table>

          <label>Verwendende Services</label>
          {usage.services.length === 0 ? <div className="help" style={{ marginBottom: 8 }}>keine</div> : (
            <div className="pill-group" style={{ marginBottom: 8 }}>
              {usage.services.map((s) => <Badge key={s.id} kind="info">{s.name}{s.stack ? ` (${s.stack})` : ''}</Badge>)}
            </div>
          )}

          <label>Verbundene Container (auf diesem Node)</label>
          {usage.containers.length === 0 ? <div className="help">keine</div> : (
            <div className="pill-group">
              {usage.containers.map((c) => <Badge key={c.id} kind="muted">{c.name}</Badge>)}
            </div>
          )}

          {usage.removable ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={confirmChk} onChange={(e) => setConfirmChk(e.target.checked)} />
              <span>Ja, Netzwerk „{net.name}" wirklich löschen.</span>
            </label>
          ) : (
            <div className="banner" style={{ marginTop: 14 }}>
              Löschen nicht möglich: {usage.reason || 'wird verwendet'}. Zuerst alle Services/Container trennen.
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function VolumeDetail({ vol, onClose, onChanged }) {
  const toast = useToast();
  const [usage, setUsage] = useState(null);
  const [err, setErr] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [dupNode, setDupNode] = useState('');
  const [dupName, setDupName] = useState(`${vol.name}-copy`);
  const [confirmChk, setConfirmChk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dupProg, setDupProg] = useState(null); // { total, bytes, done }
  const [vtab, setVtab] = useState('overview');
  const impRef = useRef(null);
  const [impBusy, setImpBusy] = useState(false);
  const [impChk, setImpChk] = useState(false);

  useEffect(() => {
    api.get(`/volumes/usage?nodeId=${encodeURIComponent(vol.nodeId || '')}&name=${encodeURIComponent(vol.name)}`)
      .then(setUsage).catch((e) => setErr(e.message));
    api.get('/nodes').then((ns) => {
      setNodes(ns || []);
      const other = (ns || []).find((n) => n.id !== vol.nodeId) || (ns || [])[0];
      if (other) setDupNode(other.id);
    }).catch(() => {});
  }, [vol.nodeId, vol.name]);

  const removable = usage && usage.services.length === 0 && usage.containers.length === 0;

  const duplicate = async () => {
    if (!dupName || !dupNode) return;
    setBusy(true);
    setDupProg({ total: null, bytes: 0, done: false });
    let errMsg = null;
    try {
      await postSSE('/volumes/duplicate',
        { srcNodeId: vol.nodeId, name: vol.name, dstNodeId: dupNode, newName: dupName },
        (evt) => {
          if (evt.type === 'size') setDupProg((p) => ({ ...(p || { bytes: 0 }), total: evt.total || null }));
          else if (evt.type === 'progress') setDupProg((p) => ({ ...(p || { total: null }), bytes: evt.bytes }));
          else if (evt.type === 'done') setDupProg((p) => ({ ...(p || { bytes: 0, total: null }), done: true }));
          else if (evt.type === 'error') errMsg = evt.message;
        });
      if (errMsg) throw new Error(errMsg);
      const dst = nodes.find((n) => n.id === dupNode);
      toast(`Volume nach „${dupName}" auf ${dst?.hostname || 'Node'} dupliziert`);
      onChanged(); onClose();
    } catch (e) { toast(e.message, 'err'); setDupProg(null); } finally { setBusy(false); }
  };

  const exportVol = () => {
    const a = document.createElement('a');
    a.href = `/api/volumes/export?nodeId=${encodeURIComponent(vol.nodeId || '')}&name=${encodeURIComponent(vol.name)}`;
    document.body.appendChild(a); a.click(); a.remove();
    toast(`Export von „${vol.name}" wird vorbereitet…`);
  };

  const importVol = async (file) => {
    if (!file) return;
    setImpBusy(true);
    try {
      const t = getToken();
      const res = await fetch(
        `/api/volumes/import?nodeId=${encodeURIComponent(vol.nodeId || '')}&name=${encodeURIComponent(vol.name)}`,
        {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/x-tar' }, t ? { Authorization: 'Bearer ' + t } : {}),
          body: file,
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast(`Inhalt aus „${file.name}" in Volume „${vol.name}" importiert`);
      setImpChk(false);
      onChanged();
    } catch (e) { toast(e.message, 'err'); } finally {
      setImpBusy(false);
      if (impRef.current) impRef.current.value = '';
    }
  };

  const del = async () => {
    setBusy(true);
    try {
      await api.post('/volumes/action', { nodeId: vol.nodeId, name: vol.name, action: 'remove', force: false });
      toast(`Volume „${vol.name}" entfernt`);
      onChanged(); onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const hr = <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />;

  return (
    <Modal wide title={`Volume · ${vol.name}`} onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Schließen</button>}>
      <div className="help" style={{ marginBottom: 10 }}>Node: {vol.node} · Driver: {vol.driver} · Scope: {vol.scope}</div>
      <TabBar active={vtab} onChange={setVtab} tabs={[{ k: 'overview', label: 'Übersicht' }, { k: 'files', label: 'Dateien' }]} />
      <div className="edit-tabpanel">
      {vtab === 'files' && <FileBrowser nodeId={vol.nodeId} volume={vol.name} />}
      {vtab === 'overview' && <>
      {err && <div className="banner">{err}</div>}
      {!usage && !err && <div className="help">Lade Nutzung…</div>}
      {usage && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Services ({usage.services.length})</div>
          {usage.services.length === 0 ? <div className="help" style={{ marginBottom: 12 }}>keine</div> : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {usage.services.map((s) => <Badge key={s.id} kind="info">{s.name}{s.stack ? ` (${s.stack})` : ''}</Badge>)}
            </div>
          )}
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Container ({usage.containers.length})</div>
          {usage.containers.length === 0 ? <div className="help">keine</div> : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {usage.containers.map((c) => <Badge key={c.id} kind={c.state === 'running' ? 'ok' : 'muted'}>{c.name}{c.swarm && c.service ? ` · ${c.service}` : ''}</Badge>)}
            </div>
          )}

          {hr}
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Auf anderen Node duplizieren</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
            <label style={{ margin: 0 }}>Ziel-Node:</label>
            <select value={dupNode} onChange={(e) => setDupNode(e.target.value)} style={{ width: 200 }}>
              {nodes.map((n) => <option key={n.id} value={n.id}>{n.hostname}{n.id === vol.nodeId ? ' (Quelle)' : ''}</option>)}
            </select>
            <input value={dupName} onChange={(e) => setDupName(e.target.value)} placeholder="Neuer Volumename" style={{ width: 200 }} />
            <button className="btn primary" disabled={busy || !dupName || !dupNode} onClick={duplicate}>Duplizieren</button>
          </div>
          <div className="help" style={{ marginBottom: 4 }}>Kopiert den Inhalt in ein neues Volume (Helfer-Container mit alpine). Auf entfernten Nodes muss der Agent laufen.</div>
          {dupProg && (() => {
            const pct = dupProg.done ? 100 : (dupProg.total
              ? Math.min(99, Math.round((dupProg.bytes / dupProg.total) * 100))
              : Math.min(95, Math.round((1 - 1 / (1 + dupProg.bytes / (10 * 1024 * 1024))) * 100)));
            return (
              <div style={{ margin: '8px 0 4px' }}>
                <div className="help" style={{ marginBottom: 4 }}>
                  {dupProg.done ? 'Fertig · ' : 'Kopiere… '}{bytes(dupProg.bytes || 0)}{dupProg.total ? ` / ~${bytes(dupProg.total)}` : ''} ({pct}%)
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-elev2)', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .25s' }} />
                </div>
              </div>
            );
          })()}

          {hr}
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Inhalt exportieren / importieren</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
            <button className="btn" disabled={busy || impBusy} onClick={exportVol}>⭳ Export (.tar)</button>
            <input
              ref={impRef}
              type="file"
              accept=".tar,application/x-tar"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; importVol(f); }}
            />
            <button className="btn" disabled={busy || impBusy || !impChk} onClick={() => impRef.current?.click()}>
              {impBusy ? 'Importiere…' : '⭱ Import (.tar)'}
            </button>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginBottom: 4 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={impChk} disabled={impBusy} onChange={(e) => setImpChk(e.target.checked)} />
            Ich bestätige den Import — vorhandene Dateien im Volume „{vol.name}" können dabei überschrieben werden.
          </label>
          <div className="help" style={{ marginBottom: 4 }}>
            Export lädt den kompletten Volume-Inhalt als Tar-Archiv herunter. Import entpackt ein zuvor
            exportiertes Archiv wieder in dieses Volume (Helfer-Container mit alpine; auf entfernten Nodes muss der Agent laufen).
          </div>

          {hr}
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Volume löschen</div>
          {removable ? (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginBottom: 10 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={confirmChk} onChange={(e) => setConfirmChk(e.target.checked)} />
              Ich bestätige, dass ich Volume „{vol.name}" auf {vol.node} endgültig löschen möchte.
            </label>
          ) : (
            <div className="help" style={{ marginBottom: 10 }}>Löschen nicht möglich: Volume wird verwendet. Zuerst alle Services/Container trennen.</div>
          )}
          <button className="btn danger" disabled={busy || !removable || !confirmChk} onClick={del}>Volume löschen</button>
        </>
      )}
      </>}
      </div>
    </Modal>
  );
}

function MigrationModal({ row, onClose, onDone }) {
  const toast = useToast();
  const defName = (row.name || 'volume').replace(/[^\w.-]+/g, '_').replace(/^[^\w]+/, '') || 'volume';
  const [newName, setNewName] = useState(defName);
  const [nodes, setNodes] = useState([]);
  const [node, setNode] = useState(row.nodeId || '');
  const [chk, setChk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(null);

  useEffect(() => {
    if (row.kind === 'service') {
      api.get('/nodes').then((ns) => {
        setNodes(ns || []);
        // Prefer the node where the service task currently runs (that's where the
        // bind data lives and where we'll create + pin the volume).
        const preferred = row.taskNodeId && (ns || []).some((n) => n.id === row.taskNodeId)
          ? row.taskNodeId
          : (ns?.[0]?.id || '');
        setNode((n) => n || preferred);
      }).catch(() => {});
    }
  }, [row.kind]);

  const phaseLabel = (ph) => ({
    check: 'Status prüfen…',
    stop: row.kind === 'service' ? 'Service stoppen (Skalierung auf 0)…' : 'Container stoppen…',
    copy: 'Daten kopieren…',
    finalize: row.kind === 'service' ? 'Service-Spec aktualisieren…' : 'Container neu aufbauen…',
    done: 'Fertig',
  }[ph] || ph);

  const run = async () => {
    setBusy(true); setProg({ phase: 'check', total: null, bytes: 0, done: false });
    let err = null;
    try {
      const body = row.kind === 'service'
        ? { kind: 'service', id: row.id, source: row.source, target: row.target, newName, nodeId: node, stop: true }
        : { kind: 'container', id: row.id, source: row.source, target: row.target, newName, nodeId: row.nodeId, stop: true };
      await postSSE('/migrate', body, (e) => {
        if (e.type === 'phase') setProg((p) => ({ ...(p || {}), phase: e.phase }));
        else if (e.type === 'size') setProg((p) => ({ ...(p || {}), total: e.total || null }));
        else if (e.type === 'progress') setProg((p) => ({ ...(p || {}), bytes: e.bytes }));
        else if (e.type === 'done') setProg((p) => ({ ...(p || {}), done: true }));
        else if (e.type === 'error') err = e.message;
      });
      if (err) throw new Error(err);
      toast(`Migration abgeschlossen → Volume „${newName}"`);
      onDone(); onClose();
    } catch (e) { toast(e.message, 'err'); setProg(null); } finally { setBusy(false); }
  };

  const pct = prog
    ? (prog.done ? 100 : (prog.total
      ? Math.min(99, Math.round((prog.bytes / prog.total) * 100))
      : Math.min(95, Math.round((1 - 1 / (1 + (prog.bytes || 0) / (10 * 1024 * 1024))) * 100))))
    : 0;

  return (
    <Modal title={`Migrieren · ${row.name}`} onClose={busy ? () => {} : onClose}
      footer={<>
        <button className="btn" disabled={busy} onClick={onClose}>Abbrechen</button>
        <button className="btn primary" disabled={busy || !chk || !newName || (row.kind === 'service' && !node)} onClick={run}>Migration starten</button>
      </>}>
      <div className="help" style={{ marginBottom: 8 }}>
        {row.kind === 'service' ? 'Service' : 'Container'} <b>{row.name}</b> · Bind <span className="mono">{row.source}</span> → <span className="mono">{row.target}</span>
      </div>
      <div className="banner" style={{ marginBottom: 10 }}>
        Diese Aktion <b>stoppt</b> {row.kind === 'service' ? 'den Service (Skalierung auf 0 Replikate)' : 'den Container'} automatisch
        und migriert dann die Daten in ein neues Volume. Der Host-Bind bleibt als Fallback erhalten
        {row.kind === 'service' ? '; der Service wird anschließend wieder auf die ursprüngliche Replikat-Zahl hochgefahren.' : '; der Container bleibt anschließend gestoppt.'}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <label style={{ margin: 0 }}>Neues Volume:</label>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: 240 }} disabled={busy} />
      </div>
      {row.kind === 'service' && row.stack && (
        <div className="banner" style={{ marginBottom: 10 }}>
          ⚠️ Dieser Service gehört zum Stack „{row.stack}". Ein erneutes <span className="mono">docker stack deploy</span> würde den Bind-Mount wiederherstellen — passe die Compose-Datei entsprechend an (Volume + Placement), damit die Migration dauerhaft bleibt.
        </div>
      )}
      {row.kind === 'service' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <label style={{ margin: 0 }}>Quell-Node (Daten):</label>
          <select value={node} onChange={(e) => setNode(e.target.value)} style={{ width: 220 }} disabled={busy}>
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.hostname}</option>)}
          </select>
          <div className="help" style={{ width: '100%', marginTop: 2 }}>
            Das Volume ist node-lokal — der Service wird auf diesen Node gepinnt (node.id==), damit die Task mit den migrierten Daten startet.
          </div>
        </div>
      )}
      {!prog && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 4 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={chk} onChange={(e) => setChk(e.target.checked)} disabled={busy} />
          Ich bestätige: {row.kind === 'service' ? 'Service stoppen (auf 0 skalieren)' : 'Container stoppen'} und migrieren.
        </label>
      )}
      {prog && (
        <div style={{ marginTop: 10 }}>
          <div className="help" style={{ marginBottom: 4 }}>
            {phaseLabel(prog.phase)}{prog.phase === 'copy' ? ` ${bytes(prog.bytes || 0)}${prog.total ? ` / ~${bytes(prog.total)}` : ''} (${pct}%)` : ''}
          </div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-elev2)', overflow: 'hidden' }}>
            <div style={{ width: `${prog.phase === 'copy' || prog.done ? pct : (prog.phase === 'check' ? 8 : 96)}%`, height: '100%', background: 'var(--accent)', transition: 'width .25s' }} />
          </div>
        </div>
      )}
    </Modal>
  );
}

function ConfigDetail({ cfg, onClose, onDeleted }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [chk, setChk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/configs/${cfg.id}`).then(setD).catch((e) => setErr(e.message));
  }, [cfg.id]);

  const exportCfg = () => {
    const a = document.createElement('a');
    a.href = `/api/configs/${cfg.id}/export`;
    document.body.appendChild(a); a.click(); a.remove();
  };
  const del = async () => {
    setBusy(true);
    try { await api.del(`/configs/${cfg.id}`); toast(`Config „${cfg.name}" gelöscht`); onDeleted(); onClose(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal wide title={`Config · ${cfg.name}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Schließen</button>
        <button className="btn" disabled={busy} onClick={exportCfg}>⭳ Export</button>
        <button className="btn danger" disabled={busy || !chk} onClick={del}>Config löschen</button>
      </>}>
      {err && <div className="banner">{err}</div>}
      {!d && !err && <div className="help">Lade…</div>}
      {d && (
        <>
          <div className="help" style={{ marginBottom: 8 }}>
            ID: <span className="mono">{short(d.id)}</span> · Größe: {bytes(d.size)} · Erstellt: {ago(d.createdAt)}{d.stack ? <> · Stack: <Badge kind="muted">{d.stack}</Badge></> : null}
          </div>
          {Object.keys(d.labels || {}).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {Object.entries(d.labels).map(([k, v]) => <Badge key={k} kind="muted">{k}={v}</Badge>)}
            </div>
          )}
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Inhalt {d.binary && <Badge kind="warn">binär</Badge>}</div>
          {d.binary
            ? <div className="help">Binärer Inhalt — bitte per Export herunterladen.</div>
            : <pre className="mono" style={{ margin: 0, maxHeight: '46vh', overflow: 'auto', background: 'var(--bg-elev2)', padding: 12, borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{d.text}</pre>}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 12 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={chk} onChange={(e) => setChk(e.target.checked)} />
            Ich bestätige, dass ich diese Config löschen möchte (nur möglich, wenn kein Service sie nutzt).
          </label>
        </>
      )}
    </Modal>
  );
}

function ConfigAdd({ onClose, onDone }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const onFile = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (!name) setName(f.name);
    const buf = await f.arrayBuffer();
    let bin = ''; const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    // store as base64 payload for exact bytes
    setText(`\u0000B64:${btoa(bin)}`);
    toast(`„${f.name}" geladen (${bytes(buf.byteLength)})`);
  };

  const create = async () => {
    if (!name.trim()) { toast('Name erforderlich', 'err'); return; }
    setBusy(true);
    try {
      const body = { name: name.trim() };
      if (text.startsWith('\u0000B64:')) body.dataB64 = text.slice(5);
      else body.data = text;
      await api.post('/configs', body);
      toast(`Config „${name}" angelegt`); onDone(); onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const isFile = text.startsWith('\u0000B64:');

  return (
    <Modal wide title="Config anlegen / importieren" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Abbrechen</button>
        <button className="btn primary" disabled={busy} onClick={create}>Anlegen</button>
      </>}>
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. nginx-conf oder app_config.json" />
      </div>
      <div className="field">
        <label>Inhalt</label>
        {isFile
          ? <div className="help">Datei geladen (binär/als Bytes). Zum Bearbeiten Textfeld leeren und neu tippen.</div>
          : <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} placeholder="Config-Inhalt hier eingeben…" />}
      </div>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
      <button className="btn" onClick={() => fileRef.current?.click()}>⭱ Aus Datei importieren</button>
      {isFile && <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setText('')}>Datei verwerfen</button>}
      <div className="help" style={{ marginTop: 8 }}>Configs sind unveränderlich (immutable). Zum „Bearbeiten" eine neue Config mit geändertem Inhalt anlegen und Services darauf umstellen.</div>
    </Modal>
  );
}

function SecretAdd({ onClose, onDone }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [labels, setLabels] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const onFile = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (!name) setName(f.name);
    const buf = await f.arrayBuffer();
    let bin = ''; const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    setText(`\u0000B64:${btoa(bin)}`); // store exact bytes as base64 payload
    toast(`„${f.name}" geladen (${bytes(buf.byteLength)})`);
  };

  const parseLabels = () => {
    const out = {};
    for (const line of labels.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  };

  const create = async () => {
    if (!name.trim()) { toast('Name erforderlich', 'err'); return; }
    const isFile = text.startsWith('\u0000B64:');
    if (!isFile && !text) { toast('Wert erforderlich', 'err'); return; }
    setBusy(true);
    try {
      const body = { name: name.trim(), labels: parseLabels() };
      if (isFile) body.dataB64 = text.slice(5);
      else body.data = text;
      await api.post('/secrets', body);
      toast(`Secret „${name}" angelegt`); onDone(); onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const isFile = text.startsWith('\u0000B64:');

  return (
    <Modal wide title="🔑 Secret anlegen" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Abbrechen</button>
        <button className="btn primary" disabled={busy} onClick={create}>＋ Anlegen</button>
      </>}>
      <div className="field">
        <label>Name <span style={{ color: 'var(--red)' }}>*</span></label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. db_password oder tls_key" autoFocus />
      </div>
      <div className="field">
        <label>Wert <span style={{ color: 'var(--red)' }}>*</span></label>
        {isFile
          ? <div className="help">Datei geladen (binär/als Bytes). Zum manuellen Eintippen „Datei verwerfen" wählen.</div>
          : <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} placeholder="Geheimwert hier eingeben…" />}
      </div>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
      <button className="btn" onClick={() => fileRef.current?.click()}>⭱ Aus Datei importieren</button>
      {isFile && <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setText('')}>Datei verwerfen</button>}
      <div className="field" style={{ marginTop: 14 }}>
        <label>Labels (optional, je Zeile KEY=VALUE)</label>
        <textarea rows={2} value={labels} onChange={(e) => setLabels(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} placeholder={'env=production\nteam=backend'} />
      </div>
      <div className="help" style={{ marginTop: 8 }}>
        Secrets werden von Docker Swarm verschlüsselt (im Raft-Log) gespeichert. Der Wert kann nach dem Anlegen nicht mehr ausgelesen werden — Secrets sind unveränderlich; zum „Bearbeiten" ein neues Secret anlegen und Services darauf umstellen.
      </div>
    </Modal>
  );
}

function VolumeAdd({ onClose, onDone }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [nodes, setNodes] = useState([]);
  const [node, setNode] = useState('');
  const [driver, setDriver] = useState('local');
  const [opts, setOpts] = useState('');
  const [labels, setLabels] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/nodes').then((ns) => {
      setNodes(ns || []);
      const mgr = (ns || []).find((n) => n.leader) || (ns || []).find((n) => n.role === 'manager') || (ns || [])[0];
      if (mgr) setNode(mgr.id);
    }).catch(() => {});
  }, []);

  const parseKv = (text) => {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  };

  const create = async () => {
    if (!name.trim()) { toast('Name erforderlich', 'err'); return; }
    if (!/^[\w][\w.-]*$/.test(name.trim())) { toast('Ungültiger Volumename (nur Buchstaben, Ziffern, . _ -)', 'err'); return; }
    setBusy(true);
    try {
      await api.post('/volumes/create', {
        nodeId: node || undefined,
        name: name.trim(),
        driver: driver.trim() || 'local',
        driverOpts: parseKv(opts),
        labels: parseKv(labels),
      });
      const dst = nodes.find((n) => n.id === node);
      toast(`Volume „${name}"${dst ? ` auf ${dst.hostname}` : ''} angelegt`);
      onDone(); onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title="🗄 Volume anlegen" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Abbrechen</button>
        <button className="btn primary" disabled={busy} onClick={create}>＋ Anlegen</button>
      </>}>
      <div className="field">
        <label>Name <span style={{ color: 'var(--red)' }}>*</span></label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. app_data" autoFocus />
      </div>
      <div className="field">
        <label>Node</label>
        <select value={node} onChange={(e) => setNode(e.target.value)}>
          {nodes.map((n) => <option key={n.id} value={n.id}>{n.hostname}{n.role === 'manager' ? ' (Manager)' : ''}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Driver</label>
        <input value={driver} onChange={(e) => setDriver(e.target.value)} placeholder="local" />
      </div>
      <div className="field">
        <label>Driver-Optionen (optional, je Zeile KEY=VALUE)</label>
        <textarea rows={2} value={opts} onChange={(e) => setOpts(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }}
          placeholder={'type=nfs\no=addr=10.0.0.1,rw\ndevice=:/path'} />
      </div>
      <div className="field">
        <label>Labels (optional, je Zeile KEY=VALUE)</label>
        <textarea rows={2} value={labels} onChange={(e) => setLabels(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }}
          placeholder={'env=production\nteam=backend'} />
      </div>
      <div className="help" style={{ marginTop: 8 }}>
        Legt ein Docker-Volume auf dem gewählten Node an. Für entfernte Nodes muss der Agent laufen. Mit dem Standard-Driver „local" genügt der Name; Driver-Optionen werden z. B. für NFS/CIFS benötigt.
      </div>
    </Modal>
  );
}

export default function Resources() {
  const toast = useToast();
  const [tab, setTab] = usePersistentState('resources.tab', 'networks');
  const { data, error, loading, reload } = useApi(`/${tab}`, { poll: 10000 });
  const [netDetail, setNetDetail] = useState(null);
  const [volDetail, setVolDetail] = useState(null);
  const [migRow, setMigRow] = useState(null);
  const [volNode, setVolNode] = usePersistentState('resources.volNode', 'all');
  const [volQ, setVolQ] = useState('');
  const [volUse, setVolUse] = usePersistentState('resources.volUse', 'all'); // all | used | unused
  const [bindStatus, setBindStatus] = useState('all'); // all | ok | caution | skip
  const [bindQ, setBindQ] = useState('');
  const [cfgDetail, setCfgDetail] = useState(null);
  const [cfgAdd, setCfgAdd] = useState(false);
  const [volAdd, setVolAdd] = useState(false);
  const [secAdd, setSecAdd] = useState(false);
  const [secQ, setSecQ] = useState('');
  const [secDelChk, setSecDelChk] = useState(false);
  const [secDel, setSecDel] = useState(null); // secret row pending delete

  const stackCol = (row) => (row.stack ? <Badge kind="muted">{row.stack}</Badge> : '–');

  const volNodes = tab === 'volumes' ? [...new Set((data || []).map((v) => v.node).filter(Boolean))].sort() : [];
  const volRows = tab === 'volumes'
    ? (data || [])
      .filter((v) => volNode === 'all' || v.node === volNode)
      .filter((v) => volUse === 'all' || (volUse === 'unused' ? !v.inUse : v.inUse))
      .filter((v) => !volQ || v.name.toLowerCase().includes(volQ.toLowerCase()))
    : [];
  const bindRows = tab === 'binds'
    ? (data || [])
      .filter((b) => bindStatus === 'all' || b.migratable === bindStatus)
      .filter((b) => {
        if (!bindQ) return true;
        const t = bindQ.toLowerCase();
        return (b.name || '').toLowerCase().includes(t)
          || (b.source || '').toLowerCase().includes(t)
          || (b.target || '').toLowerCase().includes(t)
          || (b.stack || '').toLowerCase().includes(t);
      })
    : [];

  return (
    <>
      <div className="page-head">
        <div><h1>Ressourcen</h1><div className="sub">Netzwerke, Volumes, Bind-Mounts, Secrets & Configs</div></div>
      </div>

      <div className="pill-group" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t.key}
            className={`btn ${tab === t.key ? 'primary' : ''}`}
            onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'volumes' && data && (
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <label style={{ margin: 0 }}>Node:</label>
          <select style={{ width: 180 }} value={volNode} onChange={(e) => setVolNode(e.target.value)}>
            <option value="all">Alle Nodes</option>
            {volNodes.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <input style={{ maxWidth: 240 }} value={volQ} onChange={(e) => setVolQ(e.target.value)} placeholder="🔍 Volume nach Name filtern…" />
          {volQ && <button className="btn sm" onClick={() => setVolQ('')}>✕</button>}
          <label style={{ margin: '0 0 0 6px' }}>Verwendung:</label>
          <select style={{ width: 160 }} value={volUse} onChange={(e) => setVolUse(e.target.value)}>
            <option value="all">Alle</option>
            <option value="used">In Verwendung</option>
            <option value="unused">Ungenutzt</option>
          </select>
          <div className="spacer" />
          <button className="btn primary" onClick={() => setVolAdd(true)}>＋ Volume anlegen</button>
        </div>
      )}

      {tab === 'binds' && data && (
        <div className="help" style={{ marginBottom: 12 }}>
          Read-only Analyse aller Bind-Mounts (Host-Pfade) von Swarm-Services und Standalone-Containern.
          „migrierbar" = unkritischer Datenpfad; „bedingt" = repliziert/global (Named Volume wäre node-lokal);
          „nicht empfohlen" = System-/Socket-Pfad. (Keine Änderungen — reine Übersicht.)
        </div>
      )}

      {tab === 'binds' && data && (
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <input style={{ maxWidth: 280 }} value={bindQ} onChange={(e) => setBindQ(e.target.value)} placeholder="🔍 Name / Host-Pfad / Ziel filtern…" />
          {bindQ && <button className="btn sm" onClick={() => setBindQ('')}>✕</button>}
          <label style={{ margin: '0 0 0 6px' }}>Migrierbar:</label>
          <select style={{ width: 180 }} value={bindStatus} onChange={(e) => setBindStatus(e.target.value)}>
            <option value="all">Alle</option>
            <option value="ok">migrierbar</option>
            <option value="caution">bedingt</option>
            <option value="skip">nicht empfohlen</option>
          </select>
        </div>
      )}

      {tab === 'secrets' && (
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <input style={{ maxWidth: 280 }} value={secQ} onChange={(e) => setSecQ(e.target.value)} placeholder="🔍 Secret nach Name filtern…" />
          {secQ && <button className="btn sm" onClick={() => setSecQ('')}>✕</button>}
          <div className="spacer" />
          <button className="btn primary" onClick={() => setSecAdd(true)}>＋ Secret anlegen</button>
        </div>
      )}

      {tab === 'configs' && (
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <div className="spacer" />
          <button className="btn primary" onClick={() => setCfgAdd(true)}>＋ Config anlegen / importieren</button>
        </div>
      )}

      {error && <div className="banner">{error}</div>}
      {loading && !data && <div className="spinner">Lade…</div>}
      {data && data.length === 0 && <div className="empty">Keine Einträge.</div>}

      {data && data.length > 0 && (
        <div className="table-wrap">
          <table>
            {tab === 'networks' && (
              <>
                <thead><tr><th>Name</th><th>Driver</th><th>Scope</th><th>Attachable</th><th>Stack</th><th>Aktion</th></tr></thead>
                <tbody>
                  {data.map((n) => (
                    <tr key={n.id}>
                      <td style={{ fontWeight: 600 }}>
                        <span className="link-name" onClick={() => setNetDetail(n)} title="Nutzung anzeigen">{n.name}</span>
                        {n.ingress && <> <Badge kind="info">ingress</Badge></>}
                      </td>
                      <td className="mono">{n.driver}</td>
                      <td>{n.scope}</td>
                      <td>{n.attachable ? 'ja' : 'nein'}</td>
                      <td>{stackCol(n)}</td>
                      <td><button className="btn sm" onClick={() => setNetDetail(n)}>Details</button></td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
            {tab === 'volumes' && (
              <>
                <thead><tr><th>Name</th><th>Node</th><th>Driver</th><th>Scope</th><th>Verwendung</th><th>Mountpoint</th><th>Stack</th><th>Aktion</th></tr></thead>
                <tbody>
                  {volRows.length === 0 && <tr><td colSpan={8} className="empty" style={{ padding: 18 }}>Keine Treffer.</td></tr>}
                  {volRows.map((v) => (
                    <tr key={`${v.nodeId || v.node || ''}/${v.name}`}>
                      <td style={{ fontWeight: 600 }} className="mono">
                        <span className="link-name" onClick={() => setVolDetail(v)} title="Nutzung / Aktionen anzeigen">{v.name}</span>
                      </td>
                      <td>{v.node || '—'}</td>
                      <td className="mono">{v.driver}</td>
                      <td>{v.scope}</td>
                      <td>{v.inUse ? <Badge kind="ok">in Verwendung</Badge> : <Badge kind="muted">ungenutzt</Badge>}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{v.mountpoint}{v.mountpoint && <Copy text={v.mountpoint} />}</td>
                      <td>{stackCol(v)}</td>
                      <td><button className="btn sm" onClick={() => setVolDetail(v)}>Details</button></td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
            {tab === 'binds' && (
              <>
                <thead><tr><th>Typ</th><th>Name</th><th>Node</th><th>Ziel (Container)</th><th>Quelle (Host-Bind)</th><th>Modus</th><th>Migrierbar?</th><th>Aktion</th></tr></thead>
                <tbody>
                  {bindRows.length === 0 && <tr><td colSpan={8} className="empty" style={{ padding: 18 }}>Keine Treffer.</td></tr>}
                  {bindRows.map((b, i) => (
                    <tr key={`${b.kind}/${b.id}/${b.target}/${i}`}>
                      <td><Badge kind={b.kind === 'service' ? 'info' : 'muted'}>{b.kind === 'service' ? 'Service' : 'Container'}</Badge></td>
                      <td style={{ fontWeight: 600 }}>{b.name}{b.stack ? <> <Badge kind="muted">{b.stack}</Badge></> : null}</td>
                      <td>{b.node || (b.kind === 'service' ? <span className="help">swarm-weit</span> : '—')}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{b.target}{b.readOnly ? <> <Badge kind="muted">ro</Badge></> : null}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{b.source}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{b.mode ? `${b.mode}${b.replicas != null ? ` ×${b.replicas}` : ''}` : '–'}</td>
                      <td>
                        {b.migratable === 'ok' && <Badge kind="ok">migrierbar</Badge>}
                        {b.migratable === 'caution' && <Badge kind="warn">bedingt</Badge>}
                        {b.migratable === 'skip' && <Badge kind="muted">nicht empfohlen</Badge>}
                        {b.reason && <div className="help" style={{ fontSize: 11, marginTop: 2 }}>{b.reason}</div>}
                      </td>
                      <td>
                        {b.migratable !== 'skip'
                          ? <button className="btn sm" onClick={() => setMigRow(b)}>Migrieren</button>
                          : <span className="help">–</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
            {tab === 'secrets' && (
              <>
                <thead><tr><th>Name</th><th>ID</th><th>Erstellt</th><th>Stack</th><th>Aktion</th></tr></thead>
                <tbody>
                  {data
                    .filter((r) => !secQ || (r.name || '').toLowerCase().includes(secQ.toLowerCase()))
                    .map((r) => (
                      <tr key={r.id}>
                        <td style={{ fontWeight: 600 }}>{r.name}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{short(r.id)}</td>
                        <td style={{ color: 'var(--text-dim)' }}>{ago(r.createdAt)}</td>
                        <td>{stackCol(r)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn sm danger" onClick={() => { setSecDelChk(false); setSecDel(r); }}>Löschen</button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </>
            )}
            {tab === 'configs' && (
              <>
                <thead><tr><th>Name</th><th>ID</th><th>Größe</th><th>Erstellt</th><th>Stack</th><th>Aktion</th></tr></thead>
                <tbody>
                  {data.map((r) => (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>
                        <span className="link-name" onClick={() => setCfgDetail(r)} title="Inhalt anzeigen">{r.name}</span>
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>{short(r.id)}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{r.size == null ? '–' : bytes(r.size)}</td>
                      <td style={{ color: 'var(--text-dim)' }}>{ago(r.createdAt)}</td>
                      <td>{stackCol(r)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn sm" onClick={() => setCfgDetail(r)}>Details</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
        </div>
      )}

      {netDetail && <NetworkDetail net={netDetail} onClose={() => setNetDetail(null)} onDeleted={reload} />}
      {volDetail && <VolumeDetail vol={volDetail} onClose={() => setVolDetail(null)} onChanged={reload} />}
      {migRow && <MigrationModal row={migRow} onClose={() => setMigRow(null)} onDone={reload} />}
      {cfgDetail && <ConfigDetail cfg={cfgDetail} onClose={() => setCfgDetail(null)} onDeleted={reload} />}
      {cfgAdd && <ConfigAdd onClose={() => setCfgAdd(false)} onDone={reload} />}
      {volAdd && <VolumeAdd onClose={() => setVolAdd(false)} onDone={reload} />}
      {secAdd && <SecretAdd onClose={() => setSecAdd(false)} onDone={reload} />}
      {secDel && (
        <Modal title="Secret löschen" onClose={() => setSecDel(null)}
          footer={<>
            <button className="btn" onClick={() => setSecDel(null)}>Abbrechen</button>
            <button className="btn danger" disabled={!secDelChk} onClick={async () => {
              try { await api.del(`/secrets/${secDel.id}`); toast(`Secret „${secDel.name}" gelöscht`); setSecDel(null); reload(); }
              catch (e) { toast(e.message, 'err'); }
            }}>Endgültig löschen</button>
          </>}>
          <div className="help" style={{ marginBottom: 12 }}>
            Das Secret <b className="mono">{secDel.name}</b> wird entfernt. Wird es noch von einem Service verwendet, schlägt das Löschen fehl.
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={secDelChk} onChange={(e) => setSecDelChk(e.target.checked)} />
            Ich bestätige, dass ich dieses Secret endgültig löschen möchte.
          </label>
        </Modal>
      )}
    </>
  );
}
