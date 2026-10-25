import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Badge, useToast } from './ui.jsx';

const KIND_LABEL = {
  overlay: 'Overlay (Swarm-intern, geroutet)',
  macvlan: 'Macvlan (direkt im LAN, eigene MAC)',
  ipvlan: 'IPvlan L2 (direkt im LAN, geteilte MAC)',
};

const EMPTY = {
  name: '', kind: 'overlay', attachable: false, internal: false, encrypted: false,
  ipv6: false, subnet: '', gateway: '', subnet6: '', gateway6: '', macvlanMode: 'bridge', nodes: [],
};

/** Parent candidates: up + physical interfaces first. */
const parentOptions = (node) => [...(node.interfaces || [])]
  .filter((i) => i.state !== 'down' || i.kind === 'physical')
  .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'physical' ? -1 : 1));

export default function NetworkFormModal({ editNet, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [nodes, setNodes] = useState(null);       // swarm nodes incl. interfaces
  const [loading, setLoading] = useState(!!editNet);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const isEdit = !!editNet;
  const lan = form.kind !== 'overlay';

  useEffect(() => {
    let alive = true;
    api.get('/networks/nodes').then((n) => alive && setNodes(n)).catch((e) => alive && setErr(e.message));
    if (editNet) {
      api.get(`/networks/${editNet.id}/spec`)
        .then((s) => { if (alive) { setForm({ ...EMPTY, ...s, nodes: s.nodes || [] }); setLoading(false); } })
        .catch((e) => { if (alive) { setErr(e.message); setLoading(false); } });
    }
    return () => { alive = false; };
  }, [editNet]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const nodeRow = (id) => form.nodes.find((n) => n.nodeId === id);
  const setNode = (id, patch) => setForm((f) => ({ ...f, nodes: f.nodes.map((n) => (n.nodeId === id ? { ...n, ...patch } : n)) }));

  const toggleNode = (node) => {
    if (nodeRow(node.id)) { set('nodes', form.nodes.filter((n) => n.nodeId !== node.id)); return; }
    const first = parentOptions(node).find((i) => i.kind === 'physical' && i.state === 'up') || parentOptions(node)[0];
    const row = { nodeId: node.id, hostname: node.hostname, parent: first?.name || '', ipRange: '', ipRange6: '' };
    setForm((f) => ({ ...f, nodes: [...f.nodes, row] }));
    if (first) applyHints(first);
  };

  /** Pre-fill LAN subnet/gateway/IPv6 prefix from the chosen interface (only if still empty). */
  const applyHints = (iface) => setForm((f) => ({
    ...f,
    subnet: f.subnet || iface.subnet || '',
    gateway: f.gateway || iface.gateway || '',
    subnet6: f.subnet6 || (iface.subnet6 || [])[0] || '',
  }));

  const preset = () => setForm((f) => ({
    ...f, kind: 'macvlan', attachable: true, ipv6: true,
    name: f.name || 'lan-matter',
  }));

  const ifaceOf = (node, name) => (node.interfaces || []).find((i) => i.name === name);

  const submit = async () => {
    setBusy(true); setErr(null);
    const body = {
      name: form.name.trim(), kind: form.kind, attachable: form.attachable, internal: form.internal, encrypted: form.encrypted,
      ipv6: form.ipv6, subnet: form.subnet.trim(), gateway: form.gateway.trim(),
      subnet6: form.ipv6 ? form.subnet6.trim() : '', gateway6: form.ipv6 ? form.gateway6.trim() : '',
      macvlanMode: form.macvlanMode,
      nodes: lan ? form.nodes.map((n) => ({ nodeId: n.nodeId, hostname: n.hostname, parent: n.parent, ipRange: (n.ipRange || '').trim(), ipRange6: form.ipv6 ? (n.ipRange6 || '').trim() : '' })) : [],
    };
    try {
      if (isEdit) await api.put(`/networks/${editNet.id}`, body);
      else await api.post('/networks', body);
      toast(isEdit ? `Netzwerk „${body.name}" aktualisiert` : `Netzwerk „${body.name}" angelegt`);
      onDone?.(); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const L = ({ children }) => <label style={{ display: 'block', marginBottom: 4 }}>{children}</label>;
  const Row = ({ children }) => <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>{children}</div>;

  return (
    <Modal wide title={isEdit ? `Netzwerk bearbeiten · ${editNet.name}` : 'Netzwerk anlegen'} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Abbrechen</button>
        <button className="btn primary" disabled={busy || loading || !form.name.trim()} onClick={submit}>
          {isEdit ? 'Ersetzen & speichern' : 'Anlegen'}
        </button>
      </>}>
      {err && <div className="banner" style={{ marginBottom: 12 }}>{err}</div>}
      {loading && <div className="help">Lade Definition…</div>}
      {!loading && (
        <>
          {isEdit && (
            <div className="banner" style={{ marginBottom: 12 }}>
              Docker kann Netzwerke nicht nachträglich ändern. Beim Speichern wird das <b>ungenutzte</b> Netzwerk mit den neuen Werten neu angelegt
              (bei einem Fehler wird der alte Stand wiederhergestellt). Services, die das Netzwerk verwenden, müssen vorher getrennt werden.
            </div>
          )}

          {!isEdit && (
            <div className="card" style={{ padding: 10, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <b>Vorlage: Matter / IPv6 im LAN</b>
                <div className="help">Macvlan mit IPv6 und Attachable – der Service bekommt eine eigene LAN-Präsenz (Link-Local, mDNS-Multicast) und kann zusätzlich am Overlay hängen.</div>
              </div>
              <button className="btn" onClick={preset}>Vorlage anwenden</button>
            </div>
          )}

          <Row>
            <div style={{ flex: 1, minWidth: 220 }}>
              <L>Name</L>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="z. B. lan-matter" />
            </div>
            <div style={{ flex: 1, minWidth: 260 }}>
              <L>Typ</L>
              <select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
                {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </Row>

          <Row>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.attachable} onChange={(e) => set('attachable', e.target.checked)} /> Attachable (auch für einzelne Container)
            </label>
            {!lan && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={form.internal} onChange={(e) => set('internal', e.target.checked)} /> Internal (kein Zugang nach außen)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={form.encrypted} onChange={(e) => set('encrypted', e.target.checked)} /> Datenverkehr verschlüsseln (IPsec)
                </label>
              </>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.ipv6} onChange={(e) => set('ipv6', e.target.checked)} /> IPv6 aktivieren
            </label>
          </Row>

          {lan && (
            <div className="card" style={{ padding: 12, marginBottom: 12 }}>
              <b>Nodes &amp; Parent-Interface</b>
              <div className="help" style={{ marginBottom: 8 }}>
                Pro Node wird ein „config-only“-Netzwerk mit dem Parent-Interface angelegt. Wähle nur Nodes, auf denen der Service laufen soll
                (am besten per Node-Pinning fixieren). Jede Node braucht einen <b>eigenen, nicht überlappenden</b> Adressbereich.
              </div>
              {!nodes && !err && <div className="help">Lade Nodes und Interfaces…</div>}
              {(nodes || []).map((node) => {
                const row = nodeRow(node.id);
                const iface = row ? ifaceOf(node, row.parent) : null;
                return (
                  <div key={node.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                      <input type="checkbox" style={{ width: 'auto' }} checked={!!row} onChange={() => toggleNode(node)} />
                      {node.hostname}
                      <Badge kind="muted">{node.role}</Badge>
                      {node.state !== 'ready' && <Badge kind="warn">{node.state}</Badge>}
                    </label>
                    {!node.interfacesAvailable && <div className="help">Interfaces nicht ermittelbar{node.error ? ` (${node.error})` : ''} – Parent bitte manuell eintragen.</div>}
                    {row && (
                      <Row>
                        <div style={{ minWidth: 200 }}>
                          <div className="help">Parent-Interface</div>
                          {(node.interfaces || []).length > 0 ? (
                            <select value={row.parent} onChange={(e) => { setNode(node.id, { parent: e.target.value }); const i = ifaceOf(node, e.target.value); if (i) applyHints(i); }}>
                              {parentOptions(node).map((i) => (
                                <option key={i.name} value={i.name}>
                                  {i.name} · {i.state || '?'}{i.subnet ? ` · ${i.subnet}` : ''}{i.wireless ? ' · WLAN' : ''}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input value={row.parent} onChange={(e) => setNode(node.id, { parent: e.target.value })} placeholder="z. B. eth0" />
                          )}
                        </div>
                        <div style={{ minWidth: 190 }}>
                          <div className="help">IPv4-Bereich dieser Node (CIDR, leer = ganzes Subnetz)</div>
                          <input value={row.ipRange} onChange={(e) => setNode(node.id, { ipRange: e.target.value })} placeholder="z. B. 192.168.1.240/29" />
                        </div>
                        {form.ipv6 && (
                          <div style={{ minWidth: 220 }}>
                            <div className="help">IPv6-Bereich dieser Node (optional)</div>
                            <input value={row.ipRange6} onChange={(e) => setNode(node.id, { ipRange6: e.target.value })} placeholder="z. B. fd00:1::100/120" />
                          </div>
                        )}
                        {iface?.wireless && <div className="banner" style={{ flex: '1 1 100%' }}>WLAN-Interfaces unterstützen Macvlan in der Regel nicht (nur eine MAC pro Client).</div>}
                      </Row>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Row>
            <div style={{ flex: 1, minWidth: 200 }}>
              <L>IPv4-Subnetz{lan ? ' (LAN)' : ' (optional)'}</L>
              <input value={form.subnet} onChange={(e) => set('subnet', e.target.value)} placeholder={lan ? 'z. B. 192.168.1.0/24' : 'z. B. 10.20.0.0/24'} />
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <L>IPv4-Gateway{lan ? ' (Router)' : ' (optional)'}</L>
              <input value={form.gateway} onChange={(e) => set('gateway', e.target.value)} placeholder={lan ? 'z. B. 192.168.1.1' : ''} />
            </div>
            {form.kind === 'macvlan' && (
              <div style={{ minWidth: 160 }}>
                <L>Macvlan-Modus</L>
                <select value={form.macvlanMode} onChange={(e) => set('macvlanMode', e.target.value)}>
                  <option value="bridge">bridge</option>
                  <option value="private">private</option>
                  <option value="vepa">vepa</option>
                  <option value="passthru">passthru</option>
                </select>
              </div>
            )}
          </Row>
          {form.ipv6 && (
            <Row>
              <div style={{ flex: 1, minWidth: 240 }}>
                <L>IPv6-Subnetz</L>
                <input value={form.subnet6} onChange={(e) => set('subnet6', e.target.value)} placeholder="z. B. 2001:db8:1::/64 oder fd00:1::/64" />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <L>IPv6-Gateway (optional)</L>
                <input value={form.gateway6} onChange={(e) => set('gateway6', e.target.value)} placeholder="z. B. fe80::1 oder 2001:db8:1::1" />
              </div>
            </Row>
          )}

          {lan && (
            <div className="help">
              Hinweise: Die Node selbst kann ihre eigenen Macvlan-Container nicht direkt erreichen. In VMs muss der Hypervisor zusätzliche MAC-Adressen
              erlauben (z. B. „Promiscuous Mode“ / „MAC address spoofing“). Hängt ein Service zusätzlich am Overlay, bestimmt die Reihenfolge der
              Netzwerke die Standardroute – das LAN-Gateway gehört nur dem Macvlan-Netz.
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
