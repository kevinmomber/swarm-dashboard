/**
 * Node-local network helpers. Run on whichever engine imports them: the manager
 * (for its own node) or the node agent (for every node, via /net-op).
 *
 *  - interface discovery (parent candidates for macvlan/ipvlan + LAN hints)
 *  - config-only networks: the per-node half of a swarm-scoped macvlan/ipvlan
 *    network (parent interface, per-node IP range). Swarm networks reference
 *    them with --config-from.
 */
import { readFile, readdir } from 'node:fs/promises';
import { docker } from './docker.js';

const HOST_ROOT = process.env.HOST_ROOT || '/host';

// Interfaces that can never be a sensible macvlan/ipvlan parent.
const SKIP_IF = /^(lo|docker\d*|docker_gwbridge|veth.*|br-.*|virbr.*|vx-.*|vxlan.*|ov-.*|cali.*|flannel.*|cni.*|tailscale.*|ts\d+|wg.*|tun.*|tap.*)$/;

const rd = async (p) => { try { return (await readFile(p, 'utf8')).trim(); } catch { return null; } };

const hexLeToIp = (hex) => hex.match(/../g).reverse().map((h) => parseInt(h, 16)).join('.');
const maskBits = (maskIp) => maskIp.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0);

/** Parse the host's IPv4 routing table: connected subnet + default gateway per interface. */
async function ipv4Hints() {
  const txt = await rd(`${HOST_ROOT}/proc/1/net/route`);
  const hints = {};
  if (!txt) return hints;
  for (const line of txt.split('\n').slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 8) continue;
    const [iface, dest, gw, flags, , , , mask] = c;
    if (!(parseInt(flags, 16) & 1)) continue;
    const h = (hints[iface] = hints[iface] || {});
    if (dest === '00000000') { if (gw !== '00000000') h.gateway = hexLeToIp(gw); continue; }
    if (gw !== '00000000') continue;
    const bits = maskBits(hexLeToIp(mask));
    const d = hexLeToIp(dest);
    if (!h.subnet || bits < Number(h.subnet.split('/')[1])) h.subnet = `${d}/${bits}`;
  }
  return hints;
}

/** Global IPv6 prefixes per interface (only /16-aligned lengths, e.g. /64). */
async function ipv6Hints() {
  const txt = await rd(`${HOST_ROOT}/proc/1/net/if_inet6`);
  const hints = {};
  if (!txt) return hints;
  for (const line of txt.split('\n')) {
    const c = line.trim().split(/\s+/);
    if (c.length < 6) continue;
    const [addr, , plen, scope, , iface] = c;
    if (scope !== '00' || Number(plen) % 16 !== 0 || !plen) continue;
    const groups = addr.match(/.{4}/g).slice(0, Number(plen) / 16).map((g) => g.replace(/^0+(?=.)/, ''));
    (hints[iface] = hints[iface] || []).push(`${groups.join(':')}::/${Number(plen)}`);
  }
  return hints;
}

export async function listInterfaces() {
  const base = `${HOST_ROOT}/sys/class/net`;
  let names;
  try { names = await readdir(base); } catch { return { available: false, interfaces: [] }; }
  let virtual = new Set();
  try { virtual = new Set(await readdir(`${HOST_ROOT}/sys/devices/virtual/net`)); } catch { /* ignore */ }
  const [v4, v6] = await Promise.all([ipv4Hints(), ipv6Hints()]);
  const out = [];
  for (const name of names.sort()) {
    if (SKIP_IF.test(name)) continue;
    const wireless = (await rd(`${base}/${name}/wireless/status`)) != null || (await readdir(`${base}/${name}/wireless`).then(() => true).catch(() => false));
    out.push({
      name,
      state: await rd(`${base}/${name}/operstate`),
      mac: await rd(`${base}/${name}/address`),
      mtu: Number(await rd(`${base}/${name}/mtu`)) || null,
      kind: virtual.has(name) ? 'virtual' : 'physical',
      wireless,
      subnet: v4[name]?.subnet || null,
      gateway: v4[name]?.gateway || null,
      subnet6: v6[name] || [],
    });
  }
  return { available: true, interfaces: out };
}

/** Create the per-node config-only network for a macvlan/ipvlan swarm network. */
export async function createConfigNetwork({ name, kind, parent, ipam = [], ipv6 = false, macvlanMode = 'bridge' }) {
  if (!name || !parent) throw new Error('name und parent erforderlich');
  const Options = { parent };
  if (kind === 'macvlan') Options.macvlan_mode = macvlanMode || 'bridge';
  if (kind === 'ipvlan') Options.ipvlan_mode = 'l2';
  await docker.createNetwork({
    Name: name,
    ConfigOnly: true,
    EnableIPv6: !!ipv6,
    IPAM: { Config: ipam },
    Options,
    Labels: { 'swarmdash.managed': 'true', 'swarmdash.kind': kind, 'swarmdash.ipam': JSON.stringify(ipam) },
  });
  return { ok: true };
}

export async function getConfigNetwork(name) {
  try {
    const n = await docker.getNetwork(name).inspect();
    if (!n.ConfigOnly) return null;
    // Docker does not report the IPAM of config-only networks on inspect, so the
    // definition is also kept in a label (written by createConfigNetwork).
    let ipam = (n.IPAM?.Config || []).map((c) => ({ Subnet: c.Subnet, Gateway: c.Gateway, IPRange: c.IPRange }));
    if (ipam.length === 0 && n.Labels?.['swarmdash.ipam']) {
      try { ipam = JSON.parse(n.Labels['swarmdash.ipam']); } catch { /* ignore */ }
    }
    return {
      name: n.Name,
      parent: n.Options?.parent || null,
      macvlanMode: n.Options?.macvlan_mode || null,
      ipv6: !!n.EnableIPv6,
      ipam,
    };
  } catch { return null; }
}

/** Network name -> { ip, ip6, mac } for each given local container (docker inspect). */
export async function containerNetworks(ids = []) {
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const i = await docker.getContainer(id).inspect();
      out[id] = Object.fromEntries(Object.entries(i.NetworkSettings?.Networks || {}).map(([name, n]) => [
        name, { ip: n.IPAddress || null, ip6: n.GlobalIPv6Address || null, mac: n.MacAddress || null },
      ]));
    } catch { out[id] = null; }
  }));
  return out;
}

/** Remove a config-only network (refuses anything else). */
export async function removeConfigNetwork(name) {
  let n;
  try { n = await docker.getNetwork(name).inspect(); } catch { return { ok: true, absent: true }; }
  if (!n.ConfigOnly) throw new Error(`„${name}" ist kein config-only Netzwerk`);
  await docker.getNetwork(name).remove();
  return { ok: true };
}
