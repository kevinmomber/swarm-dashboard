import { Router } from 'express';
import { docker, requireManager } from '../docker.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    await requireManager();
    const filters = req.query.service ? { service: [req.query.service] } : {};
    const tasks = await docker.listTasks(
      Object.keys(filters).length ? { filters } : {}
    );
    // Resolve node hostnames for readability.
    const nodes = await docker.listNodes();
    const nodeName = new Map(nodes.map((n) => [n.ID, n.Description?.Hostname]));
    res.json(
      tasks.map((t) => ({
        id: t.ID,
        serviceId: t.ServiceID,
        nodeId: t.NodeID,
        node: nodeName.get(t.NodeID) || null,
        slot: t.Slot ?? null,
        image: (t.Spec?.ContainerSpec?.Image || '').split('@')[0],
        desiredState: t.DesiredState,
        state: t.Status?.State,
        message: t.Status?.Message,
        error: t.Status?.Err || null,
        timestamp: t.Status?.Timestamp,
      }))
    );
  } catch (err) {
    next(err);
  }
});

export default router;
