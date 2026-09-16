import { docker, requireManager } from './docker.js';
import { Readable } from 'node:stream';
import { agentBaseForNode } from './metrics.js';

/** Return the local swarm node ID the daemon socket belongs to. */
async function localNodeId() {
  const info = await docker.info();
  return info.Swarm?.NodeID || null;
}

/**
 * Resolve a running task container for a service.
 * exec/commit require the container to live on the connected daemon's node.
 */
export async function resolveRunningContainer(serviceId) {
  await requireManager();
  const svc = docker.getService(serviceId);
  const info = await svc.inspect();
  const name = info.Spec.Name;

  const tasks = await docker.listTasks({
    filters: { service: [name], 'desired-state': ['running'] },
  });
  const localId = await localNodeId();
  const nodes = await docker.listNodes();
  const nodeName = new Map(nodes.map((n) => [n.ID, n.Description?.Hostname]));

  const candidates = tasks
    .filter((t) => t.Status?.ContainerStatus?.ContainerID)
    .sort((a, b) => (a.NodeID === localId ? -1 : 1));

  if (candidates.length === 0) {
    throw new Error('Kein laufender Task-Container für diesen Service gefunden');
  }
  const task = candidates[0];
  const local = task.NodeID === localId;
  return {
    serviceName: name,
    containerId: task.Status.ContainerStatus.ContainerID,
    nodeId: task.NodeID,
    node: nodeName.get(task.NodeID) || null,
    local,
  };
}

/**
 * Create a full image snapshot of the service's running container and stream it
 * as a docker-save tarball to the HTTP response. Containers on a remote node are
 * brokered through that node's agent.
 */
export async function exportService(serviceId, res, { forceAgent = false } = {}) {
  const { serviceName, containerId, local, node, nodeId } = await resolveRunningContainer(serviceId);

  // Remote (or forced): proxy the agent's /export stream.
  if (!local || forceAgent) {
    const base = await agentBaseForNode(nodeId, node);
    if (!base) {
      const err = new Error(
        `Kein erreichbarer Node-Agent auf "${node}". Export erfordert den Agenten (globaler Service swarmdash-agent) auf diesem Node.`
      );
      err.status = 409;
      throw err;
    }
    const url = `${base}/export?container=${encodeURIComponent(containerId)}&name=${encodeURIComponent(serviceName)}`;
    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) {
      const err = new Error(`Agent-Export fehlgeschlagen (HTTP ${upstream.status})`);
      err.status = 502;
      throw err;
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/x-tar');
    res.setHeader(
      'Content-Disposition',
      upstream.headers.get('content-disposition') || `attachment; filename="${serviceName}.tar"`
    );
    await new Promise((resolve, reject) => {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', reject);
      res.on('close', resolve);
      nodeStream.on('end', resolve);
      nodeStream.pipe(res);
    });
    return;
  }

  // Local: commit + save on the connected engine.
  const container = docker.getContainer(containerId);
  const repo = `swarmdash-export/${serviceName}`.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
  const tag = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const ref = `${repo}:${tag}`;

  const committed = await container.commit({ repo, tag, comment: 'swarmdash export', pause: true });
  const imageId = committed.Id;
  const image = docker.getImage(ref);

  const fileName = `${serviceName}-${tag}.tar`;
  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  const stream = await image.get();
  await new Promise((resolve, reject) => {
    stream.on('error', reject);
    res.on('close', resolve);
    stream.on('end', resolve);
    stream.pipe(res);
  }).finally(async () => {
    await docker.getImage(imageId).remove({ force: true }).catch(() => {});
  });
}

/** Add and/or remove labels on a service (updates its spec). */
export async function updateServiceLabels(serviceId, { add = {}, remove = [] } = {}) {
  await requireManager();
  const svc = docker.getService(serviceId);
  const info = await svc.inspect();
  const spec = structuredClone(info.Spec);
  spec.Labels = spec.Labels || {};
  for (const [k, v] of Object.entries(add)) spec.Labels[k] = String(v);
  for (const k of remove) delete spec.Labels[k];
  await svc.update({ version: info.Version.Index, ...spec });
  return spec.Labels;
}
