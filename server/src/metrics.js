import { docker } from './docker.js';
import dns from 'node:dns/promises';
import { ensureImage, runEphemeral } from './ephemeral.js';

const AGENT_SERVICE = process.env.AGENT_SERVICE || 'swarmdash-agent';
const AGENT_PORT = Number(process.env.AGENT_PORT) || 9787;

/** Sum reserved CPU/memory per node from running tasks. */
export async function reservedByNode() {
  const tasks = await docker.listTasks();
  const map = new Map();
  for (const t of tasks) {
    if (t.Status?.State !== 'running') continue;
    const node = t.NodeID;
    if (!node) continue;
    const res = t.Spec?.Resources?.Reservations || {};
    if (!map.has(node)) map.set(node, { nanoCPUs: 0, memoryBytes: 0, tasks: 0 });
    const rec = map.get(node);
    rec.nanoCPUs += res.NanoCPUs || 0;
    rec.memoryBytes += res.MemoryBytes || 0;
    rec.tasks += 1;
  }
  return map;
}

/* Cache the (relatively expensive) connected-node probe. */
let cache = { at: 0, data: null };
const TTL = 20_000;

/**
 * Real host metrics for the node the daemon socket points at, via a one-shot
 * container that reads the host's df/meminfo/loadavg.
 */
export async function connectedNodeStats() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  await ensureImage();
  const script = [
    'df -P /host 2>/dev/null | tail -1',
    'echo "==="',
    'grep -E "^(MemTotal|MemAvailable):" /proc/meminfo 2>/dev/null',
    'echo "==="',
    'cat /proc/loadavg 2>/dev/null',
    'echo "==="',
    'nproc 2>/dev/null',
  ].join('; ');

  let data = null;
  try {
    const { output } = await runEphemeral(['/:/host:ro'], script);
    const [dfLine = '', memLine = '', loadLine = '', nprocLine = ''] = output
      .split('===')
      .map((s) => s.trim());

    const df = dfLine.split(/\s+/); // Filesystem 1024-blocks Used Available Capacity Mounted
    const diskTotal = (parseInt(df[1], 10) || 0) * 1024;
    const diskUsed = (parseInt(df[2], 10) || 0) * 1024;
    const diskFree = (parseInt(df[3], 10) || 0) * 1024;

    // /proc/meminfo values are in kB.
    const memKb = (key) => {
      const m = memLine.match(new RegExp(`${key}:\\s+(\\d+)`));
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    const memTotal = memKb('MemTotal');
    const memAvailable = memKb('MemAvailable');
    const memUsed = memTotal ? memTotal - memAvailable : 0;

    const load1 = parseFloat((loadLine.split(/\s+/)[0] || '0')) || 0;
    const cpus = parseInt(nprocLine, 10) || 0;

    data = {
      disk: { total: diskTotal, used: diskUsed, free: diskFree },
      mem: { total: memTotal, used: memUsed, free: memAvailable },
      cpu: { load1, cpus, loadPct: cpus ? Math.min(100, Math.round((load1 / cpus) * 100)) : null },
    };
  } catch (e) {
    data = { error: e.message };
  }
  cache = { at: Date.now(), data };
  return data;
}

/* ------------------------------------------------------------------ */
/* Node agents — live metrics for every node                          */
/* ------------------------------------------------------------------ */

let agentCache = { at: 0, data: null };
const AGENT_TTL = 12_000;

/** Resolve all agent task IPs via Docker DNS (dnsrr service + tasks. record). */
async function agentIps() {
  const names = [AGENT_SERVICE, `tasks.${AGENT_SERVICE}`];
  const ips = new Set();
  for (const name of names) {
    try {
      for (const ip of await dns.resolve4(name)) ips.add(ip);
    } catch {
      /* not resolvable (no agent / not in swarm DNS) */
    }
  }
  return [...ips];
}

/** Poll every agent's /metrics once; returns a list including the source ip. */
async function pollAgents() {
  if (agentCache.data && Date.now() - agentCache.at < AGENT_TTL) return agentCache.data;
  const ips = await agentIps();
  const results = await Promise.all(
    ips.map(async (ip) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      try {
        const r = await fetch(`http://${ip}:${AGENT_PORT}/metrics`, { signal: ctrl.signal });
        if (!r.ok) return null;
        return { ip, ...(await r.json()) };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })
  );
  agentCache = { at: Date.now(), data: results.filter(Boolean) };
  return agentCache.data;
}

/**
 * Metrics map keyed by both node id and "h:<hostname>" so callers can match a
 * node either way.
 */
export async function agentMetrics() {
  const list = await pollAgents();
  const map = {};
  for (const m of list) {
    if (m.nodeId) map[m.nodeId] = m;
    if (m.hostname) map[`h:${m.hostname}`] = m;
  }
  return map;
}

/** Base URL of the agent running on a given node (for exec/export brokering). */
export async function agentBaseForNode(nodeId, hostname) {
  const list = await pollAgents();
  const m =
    (nodeId && list.find((x) => x.nodeId === nodeId)) ||
    (hostname && list.find((x) => x.hostname === hostname));
  return m ? `http://${m.ip}:${AGENT_PORT}` : null;
}

/** All currently reachable agents (ip, nodeId, hostname). */
export async function listAgents() {
  return (await pollAgents()).map(({ ip, nodeId, hostname }) => ({ ip, nodeId, hostname, base: `http://${ip}:${AGENT_PORT}` }));
}
