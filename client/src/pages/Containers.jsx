import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../components/useApi.js';
import { Badge, stateKind, short, ago, useToast, Modal } from '../components/ui.jsx';
import Dropdown from '../components/Dropdown.jsx';
import ContainerEditModal from '../components/ContainerEditModal.jsx';
import FileBrowser from '../components/FileBrowser.jsx';

const keyOf = (c) => `${c.id}@${c.nodeId}`;
const shortImage = (img) => (img && img.startsWith('sha256:') ? img.slice(0, 19) + '…' : img);

export default function Containers() {
  const { data, error, loading, reload } = useApi('/containers', { poll: 6000 });
  const toast = useToast();
  const [node, setNode] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [pending, setPending] = useState([]);
  const [editC, setEditC] = useState(null);
  const [filesC, setFilesC] = useState(null);

  const nodes = [...new Set((data || []).map((c) => c.node).filter(Boolean))].sort();
  const states = [...new Set((data || []).map((c) => c.state).filter(Boolean))].sort();
  const query = q.trim().toLowerCase();
  const rows = (data || []).filter((c) =>
    (node === 'all' || c.node === node)
    && (statusFilter === 'all' || c.state === statusFilter)
    && (!query
      || (c.name && c.name.toLowerCase().includes(query))
      || (c.image && c.image.toLowerCase().includes(query))
      || (c.service && c.service.toLowerCase().includes(query))));

  const allSelected = rows.length > 0 && rows.every((c) => selected.has(keyOf(c)));
  const someSelected = selected.size > 0;

  const toggle = (c) => {
    const k = keyOf(c);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => {
      if (rows.every((c) => prev.has(keyOf(c)))) return new Set();
      return new Set(rows.map(keyOf));
    });
  };

  const act = async (c, action) => {
    setBusy(true);
    try {
      await api.post('/containers/action', { nodeId: c.nodeId, id: c.id, action });
      toast(`${c.name}: ${action} ausgeführt`);
      reload();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const selectedRows = rows.filter((c) => selected.has(keyOf(c)));

  // Open the confirm modal for either a single container or the current selection.
  const openConfirm = (targets) => {
    if (!targets || targets.length === 0) return;
    setPending(targets);
    setConfirmChecked(false);
    setConfirmOpen(true);
  };

  const confirmRemove = async () => {
    const targets = pending;
    if (targets.length === 0 || !confirmChecked) return;
    const fromSelection = targets.length === selectedRows.length
      && targets.every((c) => selected.has(keyOf(c)));
    setBusy(true);
    setConfirmOpen(false);
    let ok = 0; let fail = 0;
    for (const c of targets) {
      try {
        await api.post('/containers/action', { nodeId: c.nodeId, id: c.id, action: 'remove' });
        ok++;
      } catch { fail++; }
    }
    toast(fail ? `${ok} entfernt, ${fail} fehlgeschlagen` : `${ok} Container entfernt`, fail ? 'err' : 'ok');
    if (fromSelection) setSelected(new Set());
    setConfirmChecked(false);
    setPending([]);
    reload();
    setBusy(false);
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Container</h1><div className="sub">Eigenständige Container + gestoppte Service-Task-Container (zum Aufräumen), clusterweit</div></div>
        <button className="btn" onClick={reload}>↻ Aktualisieren</button>
      </div>

      <div className="toolbar">
        <label style={{ margin: 0 }}>Node:</label>
        <select style={{ width: 180 }} value={node} onChange={(e) => setNode(e.target.value)}>
          <option value="all">Alle Nodes</option>
          {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <label style={{ margin: 0 }}>Status:</label>
        <select style={{ width: 150 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">Alle</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input
          style={{ flex: 1, minWidth: 160 }}
          placeholder="🔍 Suche (Name, Image, Service)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {someSelected && (
          <button className="btn danger" disabled={busy} onClick={() => openConfirm(selectedRows)}>
            ✕ Ausgewählte entfernen ({selected.size})
          </button>
        )}
      </div>

      {error && <div className="banner">{error}</div>}
      {loading && !data && <div className="spinner">Lade Container…</div>}
      {data && rows.length === 0 && <div className="empty">{(query || statusFilter !== 'all' || node !== 'all') ? 'Keine Container entsprechen dem Filter.' : 'Keine eigenständigen Container gefunden.'}</div>}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="containers-table">
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Alle auswählen" />
                </th>
                <th>Name</th><th>Image</th><th>Node</th><th>Status</th><th>Ports</th><th>Erstellt</th><th>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={keyOf(c)} className={selected.has(keyOf(c)) ? 'row-selected' : ''}>
                  <td><input type="checkbox" checked={selected.has(keyOf(c))} onChange={() => toggle(c)} /></td>
                  <td className="cell-name">
                    <div style={{ fontWeight: 600 }}>{c.name || '–'}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{short(c.id)}</div>
                    {c.swarm && <Badge kind="warn">Swarm{c.service ? `: ${c.service}` : ''}</Badge>}
                  </td>
                  <td className="mono cell-image" style={{ fontSize: 12 }} title={c.image}>{shortImage(c.image)}</td>
                  <td><Badge kind="muted">{c.node}</Badge></td>
                  <td><Badge kind={stateKind(c.state)}>{c.state}</Badge>
                    <div className="help" style={{ fontSize: 11 }}>{c.status}</div></td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {c.ports.length ? c.ports.map((p, i) => <div key={i}>{p.published}→{p.target}/{p.protocol}</div>) : '–'}
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>{c.created ? ago(c.created * 1000) : '–'}</td>
                  <td>
                    {c.swarm
                      ? <Dropdown items={[
                          { label: 'Dateien', onClick: () => setFilesC(c), hidden: c.state !== 'running' },
                          { label: '✕ Entfernen', danger: true, onClick: () => openConfirm([c]) },
                        ]} />
                      : <Dropdown items={[
                          { label: 'Start', onClick: () => act(c, 'start'), hidden: c.state === 'running' },
                          { label: 'Stop', onClick: () => act(c, 'stop'), hidden: c.state !== 'running' },
                          { label: 'Restart', onClick: () => act(c, 'restart'), hidden: c.state !== 'running' },
                          { label: 'Dateien', onClick: () => setFilesC(c), hidden: c.state !== 'running' },
                          { label: 'Bearbeiten & Redeploy', onClick: () => setEditC(c) },
                          { label: 'Entfernen', danger: true, onClick: () => openConfirm([c]) },
                        ]} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmOpen && (
        <Modal
          title="Container endgültig entfernen"
          onClose={() => setConfirmOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setConfirmOpen(false)}>Abbrechen</button>
            <button className="btn danger" disabled={!confirmChecked || busy} onClick={confirmRemove}>
              ✕ {pending.length} Container entfernen
            </button>
          </>}
        >
          <div className="help" style={{ marginBottom: 10 }}>
            {pending.length === 1
              ? 'Der folgende Container wird unwiderruflich entfernt. Diese Aktion kann nicht rückgängig gemacht werden.'
              : `Die folgenden ${pending.length} Container werden unwiderruflich entfernt. Diese Aktion kann nicht rückgängig gemacht werden.`}
          </div>
          <div style={{ maxHeight: '38vh', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8, marginBottom: 12 }}>
            {pending.map((c) => (
              <div key={keyOf(c)} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '3px 0' }}>
                <span className="mono" style={{ overflowWrap: 'anywhere' }}>{c.name}</span>
                <span style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{c.node} · {c.state}</span>
              </div>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
            <input type="checkbox" checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} />
            {pending.length === 1
              ? 'Ja, ich möchte diesen Container endgültig entfernen.'
              : `Ja, ich möchte diese ${pending.length} Container endgültig entfernen.`}
          </label>
        </Modal>
      )}
      {editC && <ContainerEditModal container={editC} onClose={() => setEditC(null)} onDone={reload} />}
      {filesC && (
        <Modal wide title={`Dateien · ${filesC.name}`} onClose={() => setFilesC(null)}
          footer={<button className="btn" onClick={() => setFilesC(null)}>Schließen</button>}>
          <FileBrowser nodeId={filesC.nodeId} containerId={filesC.id} />
        </Modal>
      )}
    </>
  );
}
