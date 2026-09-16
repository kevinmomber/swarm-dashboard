import { useState, useEffect, useRef, useCallback } from 'react';
import { api, postSSE } from '../api.js';
import { useApi } from './useApi.js';
import { Badge, ago, useToast } from './ui.jsx';
import CodeEditor from './CodeEditor.jsx';

const TEMPLATE = `# Beispiel-Dockerfile
FROM alpine:3.20
RUN apk add --no-cache curl
CMD ["sh", "-c", "echo built by Swarm Dashboard && sleep infinity"]
`;

export default function BuilderPanel() {
  const toast = useToast();
  const { data: builder, reload } = useApi('/builder', { poll: 0 });
  const { data: registries } = useApi('/registries', { poll: 0 });
  const { data: gitRepos } = useApi('/git', { poll: 0 });

  const [dockerfile, setDockerfile] = useState(TEMPLATE);
  const [savedId, setSavedId] = useState('');
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [buildArgs, setBuildArgs] = useState('');
  const [noCache, setNoCache] = useState(false);
  const [contextGitId, setContextGitId] = useState('');
  const [contextPath, setContextPath] = useState('');
  const [pushRegistryId, setPushRegistryId] = useState('');

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState(null);
  const [log, setLog] = useState([]);
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const dockerfiles = builder?.dockerfiles || [];
  const history = builder?.history || [];

  const loadSaved = (id) => {
    setSavedId(id);
    const d = dockerfiles.find((x) => x.id === id);
    if (d) { setDockerfile(d.content); setName(d.name); }
  };

  const save = async () => {
    if (!name.trim()) { toast('Name für das Dockerfile angeben', 'err'); return; }
    try {
      const rec = await api.post('/builder/dockerfiles', { id: savedId || undefined, name: name.trim(), content: dockerfile });
      setSavedId(rec.id);
      toast('Dockerfile gespeichert');
      reload();
    } catch (e) { toast(e.message, 'err'); }
  };
  const delSaved = async () => {
    if (!savedId) return;
    if (!confirm('Gespeichertes Dockerfile löschen?')) return;
    try { await api.del(`/builder/dockerfiles/${savedId}`); setSavedId(''); setName(''); toast('Gelöscht'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const stream = useCallback(async (path, body, label) => {
    setRunning(true);
    setPhase(null);
    setLog([]);
    try {
      await postSSE(path, body, (e) => {
        if (e.type === 'log') setLog((l) => [...l, e.line]);
        else if (e.type === 'phase') setPhase(e.phase);
        else if (e.type === 'built') setLog((l) => [...l, `✓ Image gebaut: ${e.tag}`]);
        else if (e.type === 'pushed') setLog((l) => [...l, `✓ In Registry gepusht: ${e.tag}`]);
        else if (e.type === 'error') setLog((l) => [...l, `✖ Fehler: ${e.message}`]);
        else if (e.type === 'done') {
          setPhase(null);
          toast(e.status === 'success' ? `${label} erfolgreich` : `${label} fehlgeschlagen`, e.status === 'success' ? 'ok' : 'err');
        }
      });
    } catch (e) {
      setLog((l) => [...l, `✖ ${e.message}`]);
      toast(e.message, 'err');
    } finally { setRunning(false); reload(); }
  }, [reload, toast]);

  const build = () => {
    if (!tag.trim()) { toast('Image-Tag angeben (z. B. myapp:1.0)', 'err'); return; }
    stream('/builder/build', {
      dockerfile, tag: tag.trim(), buildArgs, noCache,
      contextGitId: contextGitId || undefined, contextPath: contextPath.trim() || undefined,
      pushRegistryId: pushRegistryId || undefined,
    }, 'Build');
  };
  const pruneCache = () => {
    if (!confirm('BuildKit-Build-Cache leeren?')) return;
    stream('/builder/prune-cache', {}, 'Cache-Bereinigung');
  };

  const phaseLabel = { context: 'Kontext (git clone)…', build: 'Baue Image…', push: 'Push in Registry…' };

  return (
    <>
      <div className="help" style={{ marginBottom: 12 }}>
        Integrierte CI/CD: baut Images aus einem Dockerfile direkt auf dem Manager-Node (BuildKit) und pusht sie optional in eine Registry.
        Hinweis: Ein Build liegt zunächst nur auf dem Manager — um ihn im gesamten Swarm zu nutzen, in eine Registry pushen und den Tag referenzieren.
      </div>

      <div className="grid cols-2" style={{ gap: 16, alignItems: 'start' }}>
        {/* Dockerfile editor */}
        <div className="card">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <b style={{ flex: 1 }}>Dockerfile</b>
            <select style={{ width: 180 }} value={savedId} onChange={(e) => loadSaved(e.target.value)}>
              <option value="">— gespeichertes laden —</option>
              {dockerfiles.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <CodeEditor value={dockerfile} onChange={setDockerfile} minHeight={300} />
          <div className="actions" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
            <input style={{ maxWidth: 200 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name zum Speichern" />
            <button className="btn sm" onClick={save}>Speichern</button>
            {savedId && <button className="btn sm danger" onClick={delSaved}>Löschen</button>}
          </div>
        </div>

        {/* Build config */}
        <div className="card">
          <b>Build-Konfiguration</b>
          <div className="field" style={{ marginTop: 8 }}>
            <label>Image-Tag</label>
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="myapp:1.0 oder registry.example.com/team/app:1.0" />
          </div>
          <div className="field">
            <label>Build-Args (je Zeile KEY=VALUE, optional)</label>
            <textarea rows={3} value={buildArgs} onChange={(e) => setBuildArgs(e.target.value)} placeholder={'VERSION=1.0\nNODE_ENV=production'} />
          </div>
          <div className="field">
            <label>Build-Kontext</label>
            <select value={contextGitId} onChange={(e) => setContextGitId(e.target.value)}>
              <option value="">Kein Kontext (nur Dockerfile)</option>
              {(gitRepos || []).map((g) => <option key={g.id} value={g.id}>Git: {g.name}</option>)}
            </select>
          </div>
          {contextGitId && (
            <div className="field">
              <label>Kontext-Unterpfad im Repo (optional)</label>
              <input value={contextPath} onChange={(e) => setContextPath(e.target.value)} placeholder="z. B. backend" />
            </div>
          )}
          <div className="field">
            <label>Nach dem Build pushen (optional)</label>
            <select value={pushRegistryId} onChange={(e) => setPushRegistryId(e.target.value)}>
              <option value="">Nicht pushen</option>
              {(registries || []).map((r) => <option key={r.id} value={r.id}>{r.name || r.url}</option>)}
            </select>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 12px' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={noCache} onChange={(e) => setNoCache(e.target.checked)} />
            <span>Ohne Cache bauen (<span className="mono">--no-cache</span>)</span>
          </label>
          <div className="actions" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={running} onClick={build}>{running ? 'Läuft…' : '▶ Build starten'}</button>
            <button className="btn" disabled={running} onClick={pruneCache}>Build-Cache leeren</button>
          </div>
        </div>
      </div>

      {/* Build logs */}
      {(log.length > 0 || running) && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <b>Build-Log</b>
            {phase && <Badge kind="info">{phaseLabel[phase] || phase}</Badge>}
            {running && <span className="help">läuft…</span>}
          </div>
          <div ref={logRef} className="log-view" style={{ height: 320 }}>
            {log.map((l, i) => <div key={i} className="log-line">{l}</div>)}
          </div>
        </div>
      )}

      {/* Build history */}
      <div className="card" style={{ marginTop: 16 }}>
        <b>Build-Historie</b>
        {history.length === 0 ? <div className="help" style={{ marginTop: 8 }}>Noch keine Builds.</div> : (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>Image-Tag</th><th>Status</th><th>Push</th><th>Zeit</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{h.tag || '–'}</td>
                    <td><Badge kind={h.status === 'success' ? 'ok' : h.status === 'running' ? 'warn' : 'err'}>{h.status}</Badge>{h.error && <span className="help" title={h.error}> · {h.error.slice(0, 40)}</span>}</td>
                    <td>{h.pushed ? <Badge kind="ok">gepusht</Badge> : <span className="help">–</span>}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-dim)' }}>{h.finishedAt ? ago(h.finishedAt) : ago(h.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
