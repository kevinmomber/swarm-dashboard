import { Router } from 'express';
import { docker, requireManager } from '../docker.js';
import { exportService, updateServiceLabels, resolveRunningContainer } from '../serviceops.js';
import { PROXY_LABEL, GROUP_LABEL, BACKUP_LABEL } from '../settings.js';
import { authConfigFor } from '../registryauth.js';

const router = Router();

/** Map serviceId -> { running, desired } from live tasks. */
async function taskSummary() {
  const tasks = await docker.listTasks();
  const byService = new Map();
  for (const t of tasks) {
    const sid = t.ServiceID;
    if (!byService.has(sid)) byService.set(sid, { running: 0, total: 0, states: {} });
    const rec = byService.get(sid);
    rec.total += 1;
    const state = t.Status?.State || 'unknown';
    rec.states[state] = (rec.states[state] || 0) + 1;
    if (state === 'running') rec.running += 1;
  }
  return byService;
}

router.get('/', async (req, res, next) => {
  try {
    await requireManager();
    const [services, summary] = await Promise.all([docker.listServices(), taskSummary()]);
    res.json(
      services.map((s) => {
        const spec = s.Spec || {};
        const mode = spec.Mode || {};
        const replicated = mode.Replicated;
        const desired = replicated ? replicated.Replicas : mode.Global ? null : 0;
        const sum = summary.get(s.ID) || { running: 0, total: 0, states: {} };
        const labels = spec.Labels || {};
        return {
          id: s.ID,
          name: spec.Name,
          stack: labels['com.docker.stack.namespace'] || null,
          mode: replicated ? 'replicated' : mode.Global ? 'global' : 'other',
          image: (spec.TaskTemplate?.ContainerSpec?.Image || '').split('@')[0],
          desired,
          running: sum.running,
          taskStates: sum.states,
          labels,
          backupTag: labels[BACKUP_LABEL] || null,
          proxy: labels[PROXY_LABEL] === 'true' || labels[PROXY_LABEL] === '1',
          group: labels[GROUP_LABEL] || null,
          ports: (s.Endpoint?.Ports || []).map((p) => ({
            published: p.PublishedPort,
            target: p.TargetPort,
            protocol: p.Protocol,
            mode: p.PublishMode,
          })),
          createdAt: s.CreatedAt,
          updatedAt: s.UpdatedAt,
          updateState: s.UpdateStatus?.State || null,
          version: s.Version?.Index,
        };
      })
    );
  } catch (err) {
    next(err);
  }
});

// Check every service's image for a newer version in the registry (no pull).
router.post('/check-updates', async (req, res, next) => {
  try {
    await requireManager();
    const services = await docker.listServices();
    const byTag = new Map();
    const latestFor = (tag) => {
      if (byTag.has(tag)) return byTag.get(tag);
      const p = (async () => {
        try {
          const authconfig = await authConfigFor(tag);
          const opts = authconfig ? { authconfig } : {};
          const d = await docker.getImage(tag).distribution(opts);
          return { digest: d?.Descriptor?.digest || null };
        } catch (e) { return { error: e.message }; }
      })();
      byTag.set(tag, p);
      return p;
    };
    const result = {};
    await Promise.all(
      services.map(async (s) => {
        const img = s.Spec?.TaskTemplate?.ContainerSpec?.Image || '';
        const tag = img.split('@')[0];
        const current = img.includes('@') ? img.split('@')[1] : null;
        const latest = await latestFor(tag);
        result[s.ID] = {
          image: tag,
          current,
          latest: latest.digest || null,
          updateAvailable: Boolean(current && latest.digest && current !== latest.digest),
          error: latest.error || null,
        };
      })
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    await requireManager();
    const svc = docker.getService(req.params.id);
    res.json(await svc.inspect());
  } catch (err) {
    next(err);
  }
});

// Scale a replicated service.
router.post('/:id/scale', async (req, res, next) => {
  try {
    await requireManager();
    const replicas = Number(req.body.replicas);
    if (!Number.isInteger(replicas) || replicas < 0) {
      return res.status(400).json({ error: 'replicas muss eine ganze Zahl >= 0 sein' });
    }
    const svc = docker.getService(req.params.id);
    const info = await svc.inspect();
    if (!info.Spec.Mode?.Replicated) {
      return res.status(400).json({ error: 'Nur replizierte Services können skaliert werden' });
    }
    const spec = structuredClone(info.Spec);
    spec.Mode.Replicated.Replicas = replicas;
    await svc.update({ version: info.Version.Index, ...spec });
    res.json({ ok: true, replicas });
  } catch (err) {
    next(err);
  }
});

// Update image and/or force a rolling restart.
router.post('/:id/update', async (req, res, next) => {
  try {
    await requireManager();
    const { image, force } = req.body;
    const svc = docker.getService(req.params.id);
    const info = await svc.inspect();
    const spec = structuredClone(info.Spec);
    if (image) spec.TaskTemplate.ContainerSpec.Image = image;
    if (force || !image) {
      spec.TaskTemplate.ForceUpdate = (spec.TaskTemplate.ForceUpdate || 0) + 1;
    }
    await svc.update({ version: info.Version.Index, ...spec });
    res.json({ ok: true, image: image || spec.TaskTemplate.ContainerSpec.Image });
  } catch (err) {
    next(err);
  }
});

// Full editable config of a service (prefill for the edit form).
router.get('/:id/config', async (req, res, next) => {
  try {
    await requireManager();
    const info = await docker.getService(req.params.id).inspect();
    const spec = info.Spec || {};
    const cs = spec.TaskTemplate?.ContainerSpec || {};
    const mode = spec.Mode || {};
    const nets = await docker.listNetworks();
    const nameById = new Map(nets.map((n) => [n.Id, n.Name]));
    const networks = (spec.TaskTemplate?.Networks || []).map((n) => nameById.get(n.Target) || n.Target);
    const availableNetworks = nets
      .filter((n) => n.Scope === 'swarm' || n.Driver === 'overlay')
      .map((n) => n.Name)
      .filter((n) => n && n !== 'ingress')
      .sort();
    const ports = (spec.EndpointSpec?.Ports || []).map((p) => ({
      published: p.PublishedPort ?? '', target: p.TargetPort, protocol: (p.Protocol || 'tcp'), mode: p.PublishMode || 'ingress',
    }));
    const mounts = (cs.Mounts || []).map((m) => ({
      type: m.Type || 'volume', source: m.Source || '', target: m.Target || '', readOnly: !!m.ReadOnly,
    }));
    res.json({
      id: info.ID,
      name: spec.Name,
      image: (cs.Image || '').split('@')[0],
      mode: mode.Replicated ? 'replicated' : mode.Global ? 'global' : 'other',
      replicas: mode.Replicated?.Replicas ?? null,
      env: cs.Env || [],
      args: cs.Args || [],
      restartCondition: spec.TaskTemplate?.RestartPolicy?.Condition || 'any',
      ports,
      mounts,
      networks,
      availableNetworks,
    });
  } catch (err) {
    next(err);
  }
});

// Apply a full edit to a service (rolling redeploy via swarm update).
router.post('/:id/edit', async (req, res, next) => {
  try {
    await requireManager();
    const patch = req.body?.patch || req.body || {};
    const svc = docker.getService(req.params.id);
    const info = await svc.inspect();
    const spec = structuredClone(info.Spec);
    spec.TaskTemplate = spec.TaskTemplate || {};
    spec.TaskTemplate.ContainerSpec = spec.TaskTemplate.ContainerSpec || {};
    const cs = spec.TaskTemplate.ContainerSpec;

    if (typeof patch.image === 'string' && patch.image.trim()) cs.Image = patch.image.trim();
    if (Array.isArray(patch.env)) cs.Env = patch.env;
    if (Array.isArray(patch.args)) cs.Args = patch.args.length ? patch.args : undefined;
    if (spec.Mode?.Replicated && patch.replicas !== undefined && patch.replicas !== null && patch.replicas !== '') {
      const r = Number(patch.replicas);
      if (Number.isInteger(r) && r >= 0) spec.Mode.Replicated.Replicas = r;
    }
    if (typeof patch.restartCondition === 'string' && patch.restartCondition) {
      spec.TaskTemplate.RestartPolicy = { ...(spec.TaskTemplate.RestartPolicy || {}), Condition: patch.restartCondition };
    }
    if (Array.isArray(patch.ports)) {
      spec.EndpointSpec = spec.EndpointSpec || {};
      spec.EndpointSpec.Ports = patch.ports
        .filter((p) => String(p.target ?? '').trim())
        .map((p) => {
          const port = { Protocol: (p.protocol || 'tcp'), TargetPort: Number(p.target), PublishMode: p.mode || 'ingress' };
          if (String(p.published ?? '').trim() !== '') port.PublishedPort = Number(p.published);
          return port;
        });
    }
    if (Array.isArray(patch.mounts)) {
      cs.Mounts = patch.mounts
        .filter((m) => m && m.source && m.target)
        .map((m) => ({ Type: m.type === 'bind' ? 'bind' : 'volume', Source: String(m.source).trim(), Target: String(m.target).trim(), ReadOnly: Boolean(m.readOnly) }));
    }
    if (Array.isArray(patch.networks)) {
      const nets = await docker.listNetworks();
      const idByName = new Map(nets.map((n) => [n.Name, n.Id]));
      spec.TaskTemplate.Networks = patch.networks.map((nn) => ({ Target: idByName.get(nn) || nn }));
    }
    spec.TaskTemplate.ForceUpdate = (spec.TaskTemplate.ForceUpdate || 0) + 1;
    await svc.update({ version: info.Version.Index, ...spec });
    res.json({ ok: true, image: cs.Image });
  } catch (err) {
    next(err);
  }
});

// Resolve a running task container (id + node + image) for inspection tabs.
router.get('/:id/runtime', async (req, res, next) => {
  try {
    await requireManager();
    const rc = await resolveRunningContainer(req.params.id);
    const info = await docker.getService(req.params.id).inspect();
    const image = (info.Spec.TaskTemplate?.ContainerSpec?.Image || '').split('@')[0];
    res.json({ containerId: rc.containerId, nodeId: rc.nodeId, node: rc.node, image });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await requireManager();
    await docker.getService(req.params.id).remove();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Add/remove labels (used by tagging, backup, proxy).
router.post('/:id/labels', async (req, res, next) => {
  try {
    const { add = {}, remove = [] } = req.body || {};
    const labels = await updateServiceLabels(req.params.id, { add, remove });
    res.json({ ok: true, labels });
  } catch (err) {
    next(err);
  }
});

// Export the service's running container as a downloadable image tarball.
router.get('/:id/export', async (req, res, next) => {
  try {
    await exportService(req.params.id, res, { forceAgent: req.query.via === 'agent' });
  } catch (err) {
    if (!res.headersSent) next(err);
    else res.destroy();
  }
});

// Placement: which nodes currently run this service's tasks.
router.get('/:id/placement', async (req, res, next) => {
  try {
    await requireManager();
    const info = await docker.getService(req.params.id).inspect();
    const name = info.Spec.Name;
    const [tasks, nodes] = await Promise.all([
      docker.listTasks({ filters: { service: [name] } }),
      docker.listNodes(),
    ]);
    const nodeMap = new Map(
      nodes.map((n) => [n.ID, {
        id: n.ID,
        hostname: n.Description?.Hostname,
        role: n.Spec?.Role,
        availability: n.Spec?.Availability,
        state: n.Status?.State,
        leader: n.ManagerStatus?.Leader ?? false,
      }])
    );
    const running = tasks
      .filter((t) => t.Status?.State === 'running')
      .map((t) => ({
        taskId: t.ID,
        slot: t.Slot ?? null,
        state: t.Status?.State,
        desiredState: t.DesiredState,
        timestamp: t.Status?.Timestamp,
        node: nodeMap.get(t.NodeID) || { hostname: t.NodeID, role: '?', id: t.NodeID },
      }))
      .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    res.json({ service: name, tasks: running });
  } catch (err) {
    next(err);
  }
});

export default router;
