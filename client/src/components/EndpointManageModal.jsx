import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Badge, bytes, ago, useToast } from './ui.jsx';
import TabBar from './TabBar.jsx';

/** Manage a single (remote or local) Docker endpoint: containers, images, volumes. */
export default function EndpointManageModal({ endpoint, onClose }) {
  const toast = useToast();
  const ro = endpoint.readOnly;
  const [tab, setTab] = useState('containers');
  const [data, setData] = useState({ containers: null, images: null, volumes: null });
  const [busy, setBusy] = useState(false);

  const load = async (which) => {
    try {
      const r = await api.get(`/endpoints/${endpoint.id}/${which}`);
      setData((d) => ({ ...d, [which]: r }));
    } catch (e) { toast(e.message, 'err'); setData((d) => ({ ...d, [which]: [] })); }
  };
  useEffect(() => { load(tab); /* eslint-disable-next-line */ }, [tab, endpoint.id]);

  const act = async (fn, okMsg) => {
    setBusy(true);
    try { await fn(); if (okMsg) toast(okMsg); await load(tab); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const cAction = (c, action) => act(
    () => api.post(`/endpoints/${endpoint.id}/containers/${c.id}/${action}`),
    `${c.name}: ${action}`,
  );
  const rmImage = (im) => {
    if (!window.confirm(`Image ${(im.repoTags[0] || im.id)} entfernen?`)) return;
    act(() => api.del(`/endpoints/${endpoint.id}/images/${encodeURIComponent(im.id)}?force=true`), 'Image entfernt');
  };
  const rmVolume = (v) => {
    if (!window.confirm(`Volume ${v.name} entfernen?`)) return;
    act(() => api.del(`/endpoints/${endpoint.id}/volumes/${encodeURIComponent(v.name)}`), 'Volume entfernt');
  };

  return (
    <Modal wide title={`Verwalten · ${endpoint.name}`} onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Schließen</button>}>
      <div style={{ marginBottom: 8 }}>
        {ro && <Badge kind="warn">read-only — Schreibaktionen gesperrt</Badge>}
      </div>
      <TabBar active={tab} onChange={setTab} tabs={[
        { k: 'containers', label: 'Container' }, { k: 'images', label: 'Images' }, { k: 'volumes', label: 'Volumes' },
      ]} />
      <div className="edit-tabpanel">
        {tab === 'containers' && (
          data.containers == null ? <div className="spinner">Lade…</div> :
          data.containers.length === 0 ? <div className="empty">Keine Container.</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Name</th><th>Image</th><th>Status</th><th>Aktionen</th></tr></thead>
              <tbody>{data.containers.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.image}</td>
                  <td><Badge kind={c.state === 'running' ? 'ok' : c.state === 'exited' ? 'err' : 'muted'}>{c.state}</Badge></td>
                  <td>{ro ? <span className="help">read-only</span> : (
                    <div className="actions">
                      {c.state !== 'running' && <button className="btn sm" disabled={busy} onClick={() => cAction(c, 'start')}>Start</button>}
                      {c.state === 'running' && <button className="btn sm" disabled={busy} onClick={() => cAction(c, 'stop')}>Stop</button>}
                      <button className="btn sm" disabled={busy} onClick={() => cAction(c, 'restart')}>Restart</button>
                      <button className="btn sm danger" disabled={busy} onClick={() => cAction(c, 'remove')}>Entfernen</button>
                    </div>
                  )}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )
        )}
        {tab === 'images' && (
          data.images == null ? <div className="spinner">Lade…</div> :
          data.images.length === 0 ? <div className="empty">Keine Images.</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Tag</th><th>Größe</th><th>Erstellt</th><th>Aktion</th></tr></thead>
              <tbody>{data.images.map((im) => (
                <tr key={im.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{im.repoTags[0] || '<none>'}</td>
                  <td>{bytes(im.size)}</td>
                  <td className="help">{ago(im.created * 1000)}</td>
                  <td>{ro ? <span className="help">read-only</span> : <button className="btn sm danger" disabled={busy} onClick={() => rmImage(im)}>Entfernen</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )
        )}
        {tab === 'volumes' && (
          data.volumes == null ? <div className="spinner">Lade…</div> :
          data.volumes.length === 0 ? <div className="empty">Keine Volumes.</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Name</th><th>Driver</th><th>Mountpoint</th><th>Aktion</th></tr></thead>
              <tbody>{data.volumes.map((v) => (
                <tr key={v.name}>
                  <td className="mono" style={{ fontWeight: 600 }}>{v.name}</td>
                  <td className="mono">{v.driver}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{v.mountpoint}</td>
                  <td>{ro ? <span className="help">read-only</span> : <button className="btn sm danger" disabled={busy} onClick={() => rmVolume(v)}>Entfernen</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )
        )}
      </div>
    </Modal>
  );
}
