/**
 * Network management (manager side).
 *
 * Supports three kinds of swarm networks:
 *  - overlay: classic routed overlay (optional IPv6, internal, encryption)
 *  - macvlan / ipvlan: LAN-attached networks. Swarm needs a per-node "config-only"
 *    network (parent interface + per-node address range) and a swarm-scoped
 *    network that references it via ConfigFrom. This module creates/removes both
 *    halves, using the node agents for remote nodes.
 *
 * Docker cannot modify a network in place, so "edit" replaces an UNUSED network
 * (remove + create) and rolls back to the previous definition on failure.
 */
import { docker, requireManager } from './docker.js';
import { agentBaseForNode } from './metrics.js';
import { listInterfaces, createConfigNetwork, getConfigNetwork, removeConfigNetwork, containerNetworks } from './netlocal.js';

const RESERVED = new Set(['host', 'bridge', 'none', 'ingress', 'docker_gwbridge']);
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const CIDR4 = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;
const IP4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const CIDR6 = /^[0-9a-fA-F:]+\/\d{1,3}$/;
const IP6 = /^[0-9a-fA-F:]+$/;
const KINDS = ['overlay', 'macvlan', 'ipvlan'];

async function fetchT(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

async function localNodeId() {
  const info = await docker.info();
  return info.Swarm?.NodeID || null;
}

/** Run a node-local network op on a swarm node (agent for remote, direct for the local engine). */
async function nodeOp(node, op, payload = {}) {
  const base = await agentBaseForNode(node.id, node.hostname);
  if (base) {
    const r = await fetchT(`${base}/net-op`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, ...payload }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${node.hostname}: ${j.error || `HTTP ${r.status}`}`);
    return j;
  }
  if (node.id === (await localNodeId())) {
    if (op === 'interfaces') return listInterfaces();
    if (op === 'config-get') return { config: await getConfigNetwork(payload.name) };
    if (op === 'config-create') return createConfigNetwork(payload);
    if (op === 'config-remove') return removeConfigNetwork(payload.name);
    if (op === 'container-nets') return { nets: await containerNetworks(payload.ids || []) };
  }
  throw new Error(`${node.hostname}: kein Agent erreichbar`);
}

/**
 * Actual per-network addresses of containers, read on their own node. Needed for
 * macvlan/ipvlan networks, which swarm does not list in task network attachments.
 * @param items [{ nodeId, containerId }]  -> { [containerId]: { [networkName]: { ip, ip6, mac } } | null }
 */
export async function containerNetworksOnNodes(items = []) {
  await requireManager();
  const nodes = await swarmNodes();
  const byNode = new Map();
  for (const it of items) {
    if (!it.containerId) continue;
    if (!byNode.has(it.nodeId)) byNode.set(it.nodeId, []);
    byNode.get(it.nodeId).push(it.containerId);
  }
  const out = {};
  await Promise.all([...byNode.entries()].map(async ([nodeId, ids]) => {
    const node = nodes.find((n) => n.id === nodeId);
    try {
      if (!node) throw new Error('node unknown');
      Object.assign(out, (await nodeOp(node, 'container-nets', { ids })).nets || {});
    } catch { for (const id of ids) out[id] = null; }
  }));
  return out;
}

export async function swarmNodes() {
  const nodes = await docker.listNodes();
  return nodes.map((n) => ({
    id: n.ID,
    hostname: n.Description?.Hostname || n.ID,
    role: n.Spec?.Role,
    state: n.Status?.State,
    availability: n.Spec?.Availability,
  }));
}

/** Nodes with their physical interfaces (parent picker + LAN hints for the form). */
export async function nodesWithInterfaces() {
  await requireManager();
  const nodes = await swarmNodes();
  return Promise.all(nodes.map(async (n) => {
    try {
      const r = await nodeOp(n, 'interfaces');
      return { ...n, interfaces: r.interfaces || [], interfacesAvailable: r.available !== false };
    } catch (e) {
      return { ...n, interfaces: [], interfacesAvailable: false, error: e.message };
    }
  }));
}

/* ------------------------------ validation ------------------------------ */

function validIp(v, cidr = false) { return cidr ? CIDR4.test(v) : IP4.test(v); }

const ip4ToInt = (ip) => ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
const octetsOk = (s) => s.split('/')[0].split('.').every((o) => Number(o) <= 255);
/** Is the IPv4 CIDR/address `inner` fully inside the CIDR `outer`? */
function inside4(inner, outer) {
  const [oAddr, oBits] = outer.split('/'); const [iAddr, iBitsRaw] = inner.split('/');
  const oB = Number(oBits); const iB = iBitsRaw === undefined ? 32 : Number(iBitsRaw);
  if (iB < oB) return false;
  const mask = oB === 0 ? 0 : (0xFFFFFFFF << (32 - oB)) >>> 0;
  return ((ip4ToInt(iAddr) & mask) >>> 0) === ((ip4ToInt(oAddr) & mask) >>> 0);
}

function validate(spec) {
  const errs = [];
  if (!NAME_RE.test(spec.name || '')) errs.push('Name: nur Buchstaben, Ziffern, _ . - (max. 63 Zeichen)');
  if (RESERVED.has(spec.name)) errs.push(`Name „${spec.name}" ist reserviert`);
  if (!KINDS.includes(spec.kind)) errs.push('Typ muss overlay, macvlan oder ipvlan sein');
  if (spec.subnet && !CIDR4.test(spec.subnet)) errs.push('IPv4-Subnetz ungültig (z. B. 192.168.1.0/24)');
  if (spec.subnet && CIDR4.test(spec.subnet) && !octetsOk(spec.subnet)) errs.push('IPv4-Subnetz ungültig (Oktett > 255)');
  if (spec.gateway && !IP4.test(spec.gateway)) errs.push('IPv4-Gateway ungültig');
  if (spec.subnet && spec.gateway && CIDR4.test(spec.subnet) && IP4.test(spec.gateway) && octetsOk(spec.gateway) && !inside4(spec.gateway, spec.subnet)) {
    errs.push(`IPv4-Gateway ${spec.gateway} liegt nicht im Subnetz ${spec.subnet}`);
  }
  if (spec.subnet6 && !CIDR6.test(spec.subnet6)) errs.push('IPv6-Subnetz ungültig (z. B. 2001:db8:1::/64)');
  if (spec.gateway6 && !IP6.test(spec.gateway6)) errs.push('IPv6-Gateway ungültig');
  if (spec.ipv6 && spec.kind !== 'overlay' && !spec.subnet6) errs.push('IPv6 benötigt ein IPv6-Subnetz');
  if (spec.kind === 'overlay' && spec.ipv6 && !spec.subnet6) errs.push('IPv6 benötigt ein IPv6-Subnetz');
  if (spec.kind !== 'overlay') {
    if (!spec.subnet) errs.push('Macvlan/ipvlan benötigt ein IPv4-Subnetz (das LAN-Subnetz)');
    if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) errs.push('Mindestens eine Node auswählen');
    for (const n of spec.nodes || []) {
      if (!n.parent) errs.push(`Node ${n.hostname || n.nodeId}: Parent-Interface fehlt`);
      if (n.ipRange && !CIDR4.test(n.ipRange)) errs.push(`Node ${n.hostname || n.nodeId}: IPv4-Bereich ungültig`);
      else if (n.ipRange && spec.subnet && CIDR4.test(spec.subnet) && !inside4(n.ipRange, spec.subnet)) {
        errs.push(`Node ${n.hostname || n.nodeId}: IPv4-Bereich ${n.ipRange} liegt nicht im Subnetz ${spec.subnet}`);
      }
      if (n.ipRange6 && !CIDR6.test(n.ipRange6)) errs.push(`Node ${n.hostname || n.nodeId}: IPv6-Bereich ungültig`);
    }
    const ranges = (spec.nodes || []).map((n) => n.ipRange).filter(Boolean);
    if (new Set(ranges).size !== ranges.length) errs.push('Die IPv4-Bereiche der Nodes dürfen sich nicht überschneiden (identisch)');
  }
  return errs;
}

const configName = (name) => `${name}-cfg`;

/* -------------------------------- create -------------------------------- */

function ipamFor(subnet, gateway, ipRange) {
  const c = {};
  if (subnet) c.Subnet = subnet;
  if (gateway) c.Gateway = gateway;
  if (ipRange) c.IPRange = ipRange;
  return c;
}

export async function createNetworkFromSpec(spec) {
  await requireManager();
  const errs = validate(spec);
  if (errs.length) { const e = new Error(errs.join('; ')); e.status = 400; throw e; }
  const existing = await docker.listNetworks();
  if (existing.some((n) => n.Name === spec.name)) { const e = new Error(`Netzwerk „${spec.name}" existiert bereits`); e.status = 409; throw e; }

  const labels = { 'swarmdash.managed': 'true', 'swarmdash.kind': spec.kind, ...(spec.labels || {}) };
  const createdCfg = []; // nodes where we created a config-only net (for rollback)
  try {
    if (spec.kind === 'overlay') {
      const IPAM = { Config: [] };
      if (spec.subnet) IPAM.Config.push(ipamFor(spec.subnet, spec.gateway));
      if (spec.subnet6) IPAM.Config.push(ipamFor(spec.subnet6, spec.gateway6));
      const Options = {};
      if (spec.encrypted) Options.encrypted = 'true';
      await docker.createNetwork({
        Name: spec.name, Driver: 'overlay', Scope: 'swarm', Attachable: !!spec.attachable, Internal: !!spec.internal,
        EnableIPv6: !!spec.ipv6, IPAM, Options, Labels: labels,
      });
      return { ok: true, name: spec.name };
    }

    const cfg = configName(spec.name);
    const nodes = await swarmNodes();
    for (const n of spec.nodes) {
      const node = nodes.find((x) => x.id === n.nodeId);
      if (!node) throw new Error(`Node ${n.nodeId} nicht gefunden`);
      const ipam = [ipamFor(spec.subnet, spec.gateway, n.ipRange)];
      if (spec.subnet6) ipam.push(ipamFor(spec.subnet6, spec.gateway6, n.ipRange6));
      await nodeOp(node, 'config-create', {
        name: cfg, kind: spec.kind, parent: n.parent, ipam, ipv6: !!spec.ipv6, macvlanMode: spec.macvlanMode || 'bridge',
      });
      createdCfg.push(node);
    }
    // No Labels here: Docker rejects user-specified settings on a network that
    // depends on a config-only network. Managed networks are recognised by the
    // "<name>-cfg" naming convention instead.
    await docker.createNetwork({
      Name: spec.name, Driver: spec.kind, Scope: 'swarm', Attachable: !!spec.attachable,
      ConfigFrom: { Network: cfg },
    });
    return { ok: true, name: spec.name, configNetwork: cfg, nodes: createdCfg.map((n) => n.hostname) };
  } catch (err) {
    // Roll back the config-only halves we already created.
    for (const node of createdCfg) { try { await nodeOp(node, 'config-remove', { name: configName(spec.name) }); } catch { /* best effort */ } }
    throw err;
  }
}

/* ----------------------------- describe / usage ---------------------------- */

export async function servicesUsing(netId) {
  const services = await docker.listServices();
  return services
    .filter((s) => [...(s.Spec?.TaskTemplate?.Networks || []), ...(s.Spec?.Networks || [])].some((n) => n.Target === netId))
    .map((s) => ({ id: s.ID, name: s.Spec.Name, stack: s.Spec?.Labels?.['com.docker.stack.namespace'] || null }));
}

/** Per-node config-only definitions for a macvlan/ipvlan swarm network. */
export async function nodeConfigs(cfgName) {
  const nodes = await swarmNodes();
  const out = [];
  await Promise.all(nodes.map(async (n) => {
    try {
      const r = await nodeOp(n, 'config-get', { name: cfgName });
      if (r.config) out.push({ nodeId: n.id, hostname: n.hostname, ...r.config });
    } catch { /* node without agent / unreachable */ }
  }));
  return out.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

/** Reconstruct an editable spec from an existing network (used by the edit form and for rollback). */
export async function describeNetwork(id) {
  await requireManager();
  const n = await docker.getNetwork(id).inspect();
  const kind = n.Driver;
  const ipamCfg = n.IPAM?.Config || [];
  const v4 = ipamCfg.find((c) => c.Subnet && !c.Subnet.includes(':'));
  const v6 = ipamCfg.find((c) => c.Subnet && c.Subnet.includes(':'));
  const spec = {
    id: n.Id, name: n.Name, kind, scope: n.Scope, attachable: !!n.Attachable, internal: !!n.Internal, ipv6: !!n.EnableIPv6,
    encrypted: n.Options?.encrypted === 'true',
    labels: Object.fromEntries(Object.entries(n.Labels || {}).filter(([k]) => !k.startsWith('swarmdash.') && !k.startsWith('com.docker.'))),
    managed: n.Labels?.['swarmdash.managed'] === 'true' || (!!n.ConfigFrom?.Network && n.ConfigFrom.Network === configName(n.Name)),
    subnet: v4?.Subnet || '', gateway: v4?.Gateway || '', subnet6: v6?.Subnet || '', gateway6: v6?.Gateway || '',
    configFrom: n.ConfigFrom?.Network || null,
    editable: ['overlay', 'macvlan', 'ipvlan'].includes(kind) && n.Scope === 'swarm' && !n.Ingress && !n.ConfigOnly,
  };
  if (spec.configFrom) {
    const cfgs = await nodeConfigs(spec.configFrom);
    const first = cfgs[0];
    spec.macvlanMode = first?.macvlanMode || 'bridge';
    spec.subnet = first?.ipam?.find((c) => c.Subnet && !c.Subnet.includes(':'))?.Subnet || spec.subnet;
    spec.gateway = first?.ipam?.find((c) => c.Subnet && !c.Subnet.includes(':'))?.Gateway || spec.gateway;
    spec.subnet6 = first?.ipam?.find((c) => c.Subnet?.includes(':'))?.Subnet || spec.subnet6;
    spec.gateway6 = first?.ipam?.find((c) => c.Subnet?.includes(':'))?.Gateway || spec.gateway6;
    spec.ipv6 = spec.ipv6 || cfgs.some((c) => c.ipv6);
    spec.nodes = cfgs.map((c) => ({
      nodeId: c.nodeId, hostname: c.hostname, parent: c.parent || '',
      ipRange: c.ipam?.find((x) => x.Subnet && !x.Subnet.includes(':'))?.IPRange || '',
      ipRange6: c.ipam?.find((x) => x.Subnet?.includes(':'))?.IPRange || '',
    }));
  }
  return spec;
}

/* -------------------------------- delete --------------------------------- */

/** Remove a swarm network and, for macvlan/ipvlan, the per-node config-only halves. */
export async function deleteNetworkFully(id) {
  await requireManager();
  const n = await docker.getNetwork(id).inspect();
  if (n.Ingress) { const e = new Error('Ingress-Netzwerk kann nicht entfernt werden'); e.status = 400; throw e; }
  if (['host', 'bridge', 'none'].includes(n.Name) && ['host', 'bridge', 'null'].includes(n.Driver)) {
    const e = new Error('Standard-Netzwerke können nicht entfernt werden'); e.status = 400; throw e;
  }
  const svc = await servicesUsing(n.Id);
  const attached = Object.keys(n.Containers || {}).filter((c) => !c.startsWith('lb-'));
  if (svc.length || attached.length) { const e = new Error('Netzwerk wird noch von Services/Containern verwendet'); e.status = 409; throw e; }
  const cfgName = n.ConfigFrom?.Network || null;
  await docker.getNetwork(n.Id).remove();
  const cleaned = [];
  if (cfgName) {
    const nodes = await swarmNodes();
    for (const node of nodes) {
      try { await nodeOp(node, 'config-remove', { name: cfgName }); cleaned.push(node.hostname); } catch { /* node may not have it */ }
    }
  }
  return { ok: true, configCleaned: cleaned };
}

/* --------------------------------- edit ---------------------------------- */

/**
 * Replace an unused network with a new definition. The old definition is
 * snapshotted first; if creating the new one fails, the old one is restored.
 */
export async function replaceNetwork(id, patch) {
  await requireManager();
  const old = await describeNetwork(id);
  if (!old.editable) { const e = new Error('Dieses Netzwerk kann nicht bearbeitet werden'); e.status = 400; throw e; }
  const using = await servicesUsing(old.id);
  if (using.length) {
    const e = new Error(`Netzwerk wird von ${using.length} Service(s) verwendet (${using.map((s) => s.name).join(', ')}). Zuerst die Services trennen.`);
    e.status = 409; throw e;
  }
  const next = { ...old, ...patch, name: patch.name || old.name };
  // Validate before touching anything.
  const errs = validate(next);
  if (errs.length) { const e = new Error(errs.join('; ')); e.status = 400; throw e; }
  if (next.name !== old.name && (await docker.listNetworks()).some((n) => n.Name === next.name)) {
    const e = new Error(`Netzwerk „${next.name}" existiert bereits`); e.status = 409; throw e;
  }
  await deleteNetworkFully(old.id);
  try {
    const r = await createNetworkFromSpec(next);
    return { ok: true, replaced: true, ...r };
  } catch (err) {
    try {
      await createNetworkFromSpec(old);
    } catch (rbErr) {
      throw new Error(`${err.message} – Rollback ebenfalls fehlgeschlagen (${rbErr.message}); altes Netzwerk „${old.name}" bitte manuell anlegen`);
    }
    throw new Error(`${err.message} – altes Netzwerk „${old.name}" wurde wiederhergestellt`);
  }
}
