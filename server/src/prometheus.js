/**
 * Prometheus exposition endpoint (text format v0.0.4).
 *
 * Exposes non-sensitive operational metrics so an external Prometheus can scrape
 * the dashboard: node/service/task counts, per-service replica coverage, node
 * CPU/RAM/disk utilisation, and registered-endpoint reachability. Mounted before
 * the auth guard so scrapers (which do not send bearer tokens) can reach it.
 */
import { docker } from './docker.js';
import { agentMetrics } from './metrics.js';
import { inventory } from './endpoints.js';

const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const pct = (used, total) => (total ? Math.round((used / total) * 100) : null);

export async function renderMetrics() {
  const lines = [];
  const add = (name, help, type, samples) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const s of samples) {
      const labels = s.labels ? `{${Object.entries(s.labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
      lines.push(`${name}${labels} ${s.value}`);
    }
  };

  try {
    const info = await docker.info();
    const isManager = info.Swarm?.ControlAvailable === true;
    add('swarmdash_up', 'Dashboard reachable and Docker responding', 'gauge', [{ value: 1 }]);

    if (isManager) {
      const [nodes, services, tasks] = await Promise.all([
        docker.listNodes(), docker.listServices(), docker.listTasks(),
      ]);
      const readyNodes = nodes.filter((n) => n.Status?.State === 'ready').length;
      add('swarmdash_nodes_total', 'Number of swarm nodes', 'gauge', [{ value: nodes.length }]);
      add('swarmdash_nodes_ready', 'Number of ready swarm nodes', 'gauge', [{ value: readyNodes }]);
      add('swarmdash_services_total', 'Number of services', 'gauge', [{ value: services.length }]);
      const runningTasks = tasks.filter((t) => t.Status?.State === 'running').length;
      add('swarmdash_tasks_total', 'Number of tasks', 'gauge', [{ value: tasks.length }]);
      add('swarmdash_tasks_running', 'Number of running tasks', 'gauge', [{ value: runningTasks }]);

      const running = new Map();
      for (const t of tasks) if (t.Status?.State === 'running') running.set(t.ServiceID, (running.get(t.ServiceID) || 0) + 1);
      const desiredSamples = [], runningSamples = [];
      for (const s of services) {
        const name = s.Spec?.Name;
        const desired = s.Spec?.Mode?.Replicated?.Replicas;
        if (desired != null) desiredSamples.push({ labels: { service: name }, value: desired });
        runningSamples.push({ labels: { service: name }, value: running.get(s.ID) || 0 });
      }
      if (desiredSamples.length) add('swarmdash_service_replicas_desired', 'Desired replicas per service', 'gauge', desiredSamples);
      if (runningSamples.length) add('swarmdash_service_replicas_running', 'Running replicas per service', 'gauge', runningSamples);

      // Per-node utilisation from agents.
      try {
        const agents = await agentMetrics();
        const cpu = [], mem = [], disk = [];
        for (const n of nodes) {
          const host = n.Description?.Hostname;
          const live = agents[n.ID] || agents[`h:${host}`];
          if (!live) continue;
          if (live.cpu?.loadPct != null) cpu.push({ labels: { node: host }, value: live.cpu.loadPct });
          const m = pct(live.mem?.used, live.mem?.total); if (m != null) mem.push({ labels: { node: host }, value: m });
          const d = pct(live.disk?.used, live.disk?.total); if (d != null) disk.push({ labels: { node: host }, value: d });
        }
        if (cpu.length) add('swarmdash_node_cpu_percent', 'Node CPU load percent', 'gauge', cpu);
        if (mem.length) add('swarmdash_node_mem_percent', 'Node memory usage percent', 'gauge', mem);
        if (disk.length) add('swarmdash_node_disk_percent', 'Node disk usage percent', 'gauge', disk);
      } catch { /* agents optional */ }
    }

    // Registered endpoints reachability.
    try {
      const inv = await inventory();
      const reach = inv.filter((e) => e.reachable).length;
      add('swarmdash_endpoints_total', 'Number of registered Docker endpoints', 'gauge', [{ value: inv.length }]);
      add('swarmdash_endpoints_reachable', 'Number of reachable endpoints', 'gauge', [{ value: reach }]);
      add('swarmdash_endpoint_up', 'Per-endpoint reachability (1=up)', 'gauge',
        inv.map((e) => ({ labels: { endpoint: e.name, type: e.type || 'unknown' }, value: e.reachable ? 1 : 0 })));
    } catch { /* endpoints optional */ }
  } catch (e) {
    add('swarmdash_up', 'Dashboard reachable and Docker responding', 'gauge', [{ value: 0 }]);
  }
  return lines.join('\n') + '\n';
}
