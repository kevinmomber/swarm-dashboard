import { Router } from 'express';
import { docker, requireManager } from '../docker.js';
import { reservedByNode, connectedNodeStats, agentMetrics } from '../metrics.js';
import { history as metricsHistory } from '../metricshistory.js';

const router = Router();

// Time-series history of node CPU/RAM/disk for charts.
router.get('/history', async (req, res, next) => {
  try {
    const hours = Number(req.query.hours) || 6;
    res.json(metricsHistory({ hours }));
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    await requireManager();
    const [nodes, reserved, info, agents] = await Promise.all([
      docker.listNodes(),
      reservedByNode(),
      docker.info(),
      agentMetrics(),
    ]);
    const localId = info.Swarm?.NodeID || null;

    // Connected-node fallback (only probed if no agent covers it).
    const connectedCovered = agents[localId] || (info.Name && agents[`h:${info.Name}`]);
    let connectedStats = null;
    if (!connectedCovered) {
      connectedStats = await connectedNodeStats().catch(() => null);
    }

    res.json(
      nodes.map((n) => {
        const cap = n.Description?.Resources || {};
        const r = reserved.get(n.ID) || { nanoCPUs: 0, memoryBytes: 0, tasks: 0 };
        const isLocal = n.ID === localId;
        const agent = agents[n.ID] || agents[`h:${n.Description?.Hostname}`] || null;
        let live = null;
        if (agent && !agent.error) {
          live = { source: 'agent', cpu: agent.cpu, mem: agent.mem, disk: agent.disk };
        } else if (isLocal && connectedStats && !connectedStats.error) {
          live = { source: 'probe', cpu: connectedStats.cpu, mem: connectedStats.mem, disk: connectedStats.disk };
        }
        return {
          id: n.ID,
          hostname: n.Description?.Hostname,
          role: n.Spec?.Role,
          availability: n.Spec?.Availability,
          state: n.Status?.State,
          addr: n.Status?.Addr,
          leader: n.ManagerStatus?.Leader ?? false,
          reachability: n.ManagerStatus?.Reachability ?? null,
          engineVersion: n.Description?.Engine?.EngineVersion,
          platform: n.Description?.Platform,
          connected: isLocal,
          agentVersion: agent && !agent.error ? (agent.version || null) : null,
          resources: {
            nanoCPUs: cap.NanoCPUs,
            memoryBytes: cap.MemoryBytes,
          },
          reserved: {
            nanoCPUs: r.nanoCPUs,
            memoryBytes: r.memoryBytes,
            tasks: r.tasks,
            cpuPct: cap.NanoCPUs ? Math.round((r.nanoCPUs / cap.NanoCPUs) * 100) : null,
            memPct: cap.MemoryBytes ? Math.round((r.memoryBytes / cap.MemoryBytes) * 100) : null,
          },
          live,
          labels: n.Spec?.Labels ?? {},
          version: n.Version?.Index,
        };
      })
    );
  } catch (err) {
    next(err);
  }
});

// Real host metrics for the connected node (cached) — summary cards fallback.
router.get('/metrics', async (req, res, next) => {
  try {
    await requireManager();
    res.json(await connectedNodeStats());
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    await requireManager();
    const node = docker.getNode(req.params.id);
    res.json(await node.inspect());
  } catch (err) {
    next(err);
  }
});

// Change availability: active | pause | drain
router.post('/:id/availability', async (req, res, next) => {
  try {
    await requireManager();
    const { availability } = req.body;
    if (!['active', 'pause', 'drain'].includes(availability)) {
      return res.status(400).json({ error: 'availability muss active|pause|drain sein' });
    }
    const node = docker.getNode(req.params.id);
    const info = await node.inspect();
    const spec = { ...info.Spec, Availability: availability };
    await node.update({ version: info.Version.Index, ...spec });
    res.json({ ok: true, availability });
  } catch (err) {
    next(err);
  }
});

// Change role: worker | manager
router.post('/:id/role', async (req, res, next) => {
  try {
    await requireManager();
    const { role } = req.body;
    if (!['worker', 'manager'].includes(role)) {
      return res.status(400).json({ error: 'role muss worker|manager sein' });
    }
    const node = docker.getNode(req.params.id);
    const info = await node.inspect();
    const spec = { ...info.Spec, Role: role };
    await node.update({ version: info.Version.Index, ...spec });
    res.json({ ok: true, role });
  } catch (err) {
    next(err);
  }
});

// Remove a node from the swarm (force). Cannot remove the connected node.
router.delete('/:id', async (req, res, next) => {
  try {
    const info = await docker.info();
    if (req.params.id === info.Swarm?.NodeID) {
      return res.status(400).json({ error: 'Der verbundene Node kann nicht entfernt werden' });
    }
    await docker.getNode(req.params.id).remove({ force: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
