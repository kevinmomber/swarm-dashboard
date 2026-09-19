import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../components/useApi.js';
import { Badge, Modal, stateKind, short, useToast, Copy } from '../components/ui.jsx';
import LogViewer from '../components/LogViewer.jsx';
import Console from '../components/Console.jsx';
import TagModal from '../components/TagModal.jsx';
import PlacementModal from '../components/PlacementModal.jsx';
import ServiceEditModal from '../components/ServiceEditModal.jsx';
import MigrateModal from '../components/MigrateModal.jsx';
import Dropdown from '../components/Dropdown.jsx';

function ReplicaCell({ s }) {
  if (s.mode === 'global') return <Badge kind="info">global</Badge>;
  const ok = s.desired != null && s.running >= s.desired;
  return <Badge kind={ok ? 'ok' : s.running === 0 ? 'err' : 'warn'}>{s.running} / {s.desired ?? '?'}</Badge>;
}

/** Health derived from replica coverage + swarm update state. */
function health(s) {
  const us = (s.updateState || '').toLowerCase();
  if (['updating', 'rollback_started'].includes(us)) return { kind: 'warn', label: 'Update läuft' };
  if (['paused', 'rollback_paused'].includes(us)) return { kind: 'err', label: 'Update pausiert' };
  if (s.mode === 'global') {
    if (s.running === 0) return { kind: 'err', label: 'down' };
    return { kind: 'ok', label: 'gesund' };
  }
  if (s.desired === 0) return { kind: 'muted', label: 'gestoppt' };
  if (s.running >= (s.desired ?? 0) && s.desired != null) return { kind: 'ok', label: 'gesund' };
  if (s.running === 0) return { kind: 'err', label: 'down' };
  return { kind: 'warn', label: 'degradiert' };
}

function HealthCell({ s }) {
  const h = health(s);
  return <Badge kind={h.kind}>{h.label}</Badge>;
}

function ServiceTags({ s }) {
  return (
    <div className="pill-group">
      {s.backupTag && <Badge kind="ok">backup:{s.backupTag}</Badge>}
      {s.proxy && <Badge kind="info">proxy</Badge>}
      {s.group && <Badge kind="muted">{s.group}</Badge>}
    </div>
  );
}

function download(path) {
  const a = document.createElement('a');
  a.href = `/api${path}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const VIEWS = [
  { key: 'flat', label: 'Liste' },
  { key: 'stack', label: 'Nach Stack' },
  { key: 'group', label: 'Nach Custom-Tag' },
];

export default function Services() {
  const { data, error, loading, reload } = useApi('/services', { poll: 5000 });
  const toast = useToast();
  const [view, setView] = useState('flat');
  const [q, setQ] = useState('');
  const [placeSvc, setPlaceSvc] = useState(null);
  const [updates, setUpdates] = useState({});
  const [checking, setChecking] = useState(false);
  const [scaleSvc, setScaleSvc] = useState(null);
  const [updateSvc, setUpdateSvc] = useState(null);
  const [logSvc, setLogSvc] = useState(null);
  const [consoleSvc, setConsoleSvc] = useState(null);
  const [tagSvc, setTagSvc] = useState(null);
  const [editSvc, setEditSvc] = useState(null);
  const [migrateSvc, setMigrateSvc] = useState(null);
  const [replicas, setReplicas] = useState(1);
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState(false);

  const openScale = (s) => { setScaleSvc(s); setReplicas(s.desired ?? 1); };
  const openUpdate = (s) => { setUpdateSvc(s); setImage(s.image); };

  const doScale = async () => {
    setBusy(true);
    try {
      await api.post(`/services/${scaleSvc.id}/scale`, { replicas: Number(replicas) });
      toast(`${scaleSvc.name} auf ${replicas} Repliken skaliert`);
      setScaleSvc(null); reload();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const doUpdate = async (force) => {
    setBusy(true);
    try {
      await api.post(`/services/${updateSvc.id}/update`, force ? { force: true } : { image });
      toast(force ? `${updateSvc.name} neu gestartet` : `${updateSvc.name} aktualisiert`);
      setUpdateSvc(null); reload();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const remove = async (s) => {
    if (!confirm(`Service "${s.name}" wirklich entfernen?`)) return;
    try { await api.del(`/services/${s.id}`); toast(`${s.name} entfernt`); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const exportSvc = (s) => { toast(`Export von ${s.name} wird erstellt…`); download(`/services/${s.id}/export`); };

  const rollback = async (s) => {
    if (!window.confirm(`Service „${s.name}" auf die vorherige Version zurückrollen?`)) return;
    try {
      const r = await api.post(`/services/${s.id}/rollback`);
      toast(`${s.name} zurückgerollt${r.image ? ` (${r.image})` : ''}`);
      reload();
    } catch (e) { toast(e.message, 'err'); }
  };

  const checkUpdates = async () => {
    setChecking(true);
    try {
      const r = await api.post('/services/check-updates');
      setUpdates(r);
      const n = Object.values(r).filter((x) => x.updateAvailable).length;
      toast(n > 0 ? `${n} Service(s) mit neuem Image verfügbar` : 'Alle Services aktuell');
    } catch (e) { toast(e.message, 'err'); } finally { setChecking(false); }
  };

  const rows = (data || []).filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()));
  const groups = (() => {
    if (view === 'flat') return [{ key: null, items: rows }];
    const keyOf = (s) => (view === 'stack' ? s.stack : s.group) || '—';
    const map = new Map();
    for (const s of rows) {
      const k = keyOf(s);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(s);
    }
    return [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([key, items]) => ({ key, items }));
  })();

  const Table = ({ items }) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th><th>Image</th><th>Status</th><th>Repliken</th><th>Tags</th><th>Ports</th><th>Aktionen</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => {
            const upd = updates[s.id];
            return (
            <tr key={s.id} style={upd?.updateAvailable ? { background: 'rgba(210,153,34,.13)' } : undefined}>
              <td>
                <div style={{ fontWeight: 600 }}>
                  <span className="link-name" onClick={() => setPlaceSvc(s)} title="Platzierung anzeigen">{s.name}</span>
                  {' '}{upd?.updateAvailable && <Badge kind="warn">Update verfügbar</Badge>}
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  {short(s.id)}<Copy text={s.id} />{s.stack ? ` · ${s.stack}` : ''}
                </div>
              </td>
              <td className="mono" style={{ fontSize: 12 }}>{s.image}</td>
              <td><HealthCell s={s} /></td>
              <td><ReplicaCell s={s} /></td>
              <td><ServiceTags s={s} /></td>
              <td className="mono" style={{ fontSize: 12 }}>
                {s.ports.length ? s.ports.map((p, i) => <div key={i}>{p.published}→{p.target}/{p.protocol}</div>) : '–'}
              </td>
              <td>
                <Dropdown items={[
                  { label: 'Logs', onClick: () => setLogSvc(s) },
                  { label: 'Konsole', onClick: () => setConsoleSvc(s) },
                  { label: 'Platzierung', onClick: () => setPlaceSvc(s) },
                  { label: 'Skalieren', onClick: () => openScale(s), hidden: s.mode !== 'replicated' },
                  { label: 'Bearbeiten & Redeploy', onClick: () => setEditSvc(s) },
            { label: 'Migration (vMotion)', onClick: () => setMigrateSvc(s), hidden: s.mode === 'global' },
                  { label: upd?.updateAvailable ? 'Update (verfügbar)' : 'Update', onClick: () => openUpdate(s) },
                  { label: 'Rollback', onClick: () => rollback(s), hidden: !s.hasPrevious },
                  { label: 'Export', onClick: () => exportSvc(s) },
                  { label: 'Tag', onClick: () => setTagSvc(s) },
                  { label: 'Entfernen', onClick: () => remove(s), danger: true },
                ]} />
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div><h1>Services</h1><div className="sub">Replizierte und globale Dienste</div></div>
        <div className="actions">
          <button className="btn" disabled={checking} onClick={checkUpdates}>{checking ? 'Prüfe…' : '⟳ Nach Updates suchen'}</button>
          <button className="btn" onClick={reload}>↻ Aktualisieren</button>
        </div>
      </div>

      <div className="toolbar">
        <div className="seg">
          {VIEWS.map((v) => (
            <button key={v.key} className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)}>{v.label}</button>
          ))}
        </div>
        <input style={{ maxWidth: 260 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Service nach Name filtern…" />
        {q && <button className="btn sm" onClick={() => setQ('')}>✕</button>}
      </div>

      {error && <div className="banner">{error}</div>}
      {loading && !data && <div className="spinner">Lade Services…</div>}
      {data && data.length === 0 && <div className="empty">Keine Services vorhanden.</div>}

      {data && data.length > 0 && groups.map((g) => (
        <div key={g.key ?? 'all'} style={{ marginBottom: 20 }}>
          {g.key !== null && (
            <h2 style={{ fontSize: 15, margin: '4px 0 10px' }}>
              {view === 'stack' ? '▤ ' : '⬡ '}{g.key}
              <span className="help" style={{ marginLeft: 8 }}>({g.items.length})</span>
            </h2>
          )}
          <Table items={g.items} />
        </div>
      ))}

      {scaleSvc && (
        <Modal title={`Skalieren · ${scaleSvc.name}`} onClose={() => setScaleSvc(null)}
          footer={<>
            <button className="btn" onClick={() => setScaleSvc(null)}>Abbrechen</button>
            <button className="btn primary" disabled={busy} onClick={doScale}>Übernehmen</button>
          </>}>
          <div className="field"><label>Anzahl Repliken</label>
            <input type="number" min="0" value={replicas} onChange={(e) => setReplicas(e.target.value)} /></div>
        </Modal>
      )}

      {updateSvc && (
        <Modal title={`Update · ${updateSvc.name}`} onClose={() => setUpdateSvc(null)}
          footer={<>
            <button className="btn" onClick={() => setUpdateSvc(null)}>Abbrechen</button>
            <button className="btn" disabled={busy} onClick={() => doUpdate(true)}>Force-Restart</button>
            <button className="btn primary" disabled={busy} onClick={() => doUpdate(false)}>Image setzen</button>
          </>}>
          <div className="field"><label>Image (Tag)</label>
            <input value={image} onChange={(e) => setImage(e.target.value)} placeholder="repo/image:tag" /></div>
        </Modal>
      )}

      {logSvc && <LogViewer service={logSvc} onClose={() => setLogSvc(null)} />}
      {consoleSvc && <Console service={consoleSvc} onClose={() => setConsoleSvc(null)} />}
      {tagSvc && <TagModal service={tagSvc} onClose={() => setTagSvc(null)} onApplied={reload} />}
      {editSvc && <ServiceEditModal service={editSvc} onClose={() => setEditSvc(null)} onDone={reload} />}
      {migrateSvc && <MigrateModal service={migrateSvc} onClose={() => setMigrateSvc(null)} onDone={reload} />}
      {placeSvc && <PlacementModal service={placeSvc} onClose={() => setPlaceSvc(null)} />}
    </>
  );
}
