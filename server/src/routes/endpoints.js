import { Router } from 'express';
import { listEndpoints, addEndpoint, updateEndpoint, deleteEndpoint, testEndpoint, inventory, getDocker, isReadOnly } from '../endpoints.js';

const router = Router();

/** Block mutating calls against a read-only endpoint. */
async function guardWrite(id, res) {
  if (await isReadOnly(id)) {
    res.status(403).json({ error: 'Endpoint ist read-only' });
    return false;
  }
  return true;
}
const VALID_NAME = /^[\w][\w.-]*$/;

// Aggregated read-only node/host inventory across all endpoints.
router.get('/inventory', async (req, res, next) => {
  try { res.json(await inventory()); } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try { res.json(await listEndpoints()); } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try { res.json(await addEndpoint(req.body || {})); } catch (err) { next(err); }
});

// Test an unsaved connection definition (before saving).
router.post('/test', async (req, res, next) => {
  try {
    const body = req.body || {};
    res.json(await testEndpoint({ conn: body.conn || body, name: body.name }));
  } catch (err) { next(err); }
});

router.post('/:id/test', async (req, res, next) => {
  try { res.json(await testEndpoint(req.params.id)); } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try { res.json(await updateEndpoint(req.params.id, req.body || {})); } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { res.json(await deleteEndpoint(req.params.id)); } catch (err) { next(err); }
});

/* ---- Endpoint-scoped resource management (works for standalone AND swarm) ---- */

// Capabilities of an endpoint (feature gating in the UI).
router.get('/:id/capabilities', async (req, res, next) => {
  try {
    const client = await getDocker(req.params.id);
    const info = await client.info();
    const isManager = info.Swarm?.ControlAvailable === true;
    const isSwarm = info.Swarm?.LocalNodeState === 'active';
    res.json({
      reachable: true,
      type: isManager ? 'swarm' : isSwarm ? 'swarm-worker' : 'standalone',
      readOnly: await isReadOnly(req.params.id),
      features: {
        containers: true, images: true, volumes: true, networks: true,
        services: isManager, stacks: isManager, tasks: isManager, swarmNodes: isManager,
      },
    });
  } catch (e) { res.json({ reachable: false, error: e.message }); }
});

router.get('/:id/containers', async (req, res, next) => {
  try {
    const client = await getDocker(req.params.id);
    const list = await client.listContainers({ all: true });
    res.json(list.map((c) => ({
      id: c.Id,
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      created: c.Created,
      ports: (c.Ports || []).filter((p) => p.PublicPort).map((p) => ({ published: p.PublicPort, target: p.PrivatePort, protocol: p.Type })),
    })));
  } catch (err) { next(err); }
});

router.post('/:id/containers/:cid/:action', async (req, res, next) => {
  try {
    if (!(await guardWrite(req.params.id, res))) return;
    const { action } = req.params;
    if (!['start', 'stop', 'restart', 'remove'].includes(action)) return res.status(400).json({ error: 'Unbekannte Aktion' });
    const client = await getDocker(req.params.id);
    const c = client.getContainer(req.params.cid);
    if (action === 'start') await c.start();
    else if (action === 'stop') await c.stop();
    else if (action === 'restart') await c.restart();
    else if (action === 'remove') await c.remove({ force: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/:id/images', async (req, res, next) => {
  try {
    const client = await getDocker(req.params.id);
    const list = await client.listImages();
    res.json(list.map((im) => ({
      id: im.Id,
      repoTags: im.RepoTags || [],
      size: im.Size,
      created: im.Created,
    })));
  } catch (err) { next(err); }
});

router.delete('/:id/images/:imageId', async (req, res, next) => {
  try {
    if (!(await guardWrite(req.params.id, res))) return;
    const client = await getDocker(req.params.id);
    await client.getImage(req.params.imageId).remove({ force: req.query.force === 'true' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/:id/volumes', async (req, res, next) => {
  try {
    const client = await getDocker(req.params.id);
    const r = await client.listVolumes();
    res.json((r.Volumes || []).map((v) => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint, scope: v.Scope })));
  } catch (err) { next(err); }
});

router.post('/:id/volumes', async (req, res, next) => {
  try {
    if (!(await guardWrite(req.params.id, res))) return;
    const { name, driver } = req.body || {};
    if (!name || !VALID_NAME.test(name)) return res.status(400).json({ error: 'Ungültiger Volumename' });
    const client = await getDocker(req.params.id);
    await client.createVolume({ Name: name, Driver: driver || 'local' });
    res.json({ ok: true, name });
  } catch (err) { next(err); }
});

router.delete('/:id/volumes/:name', async (req, res, next) => {
  try {
    if (!(await guardWrite(req.params.id, res))) return;
    const client = await getDocker(req.params.id);
    await client.getVolume(req.params.name).remove({ force: req.query.force === 'true' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/:id/networks', async (req, res, next) => {
  try {
    const client = await getDocker(req.params.id);
    const list = await client.listNetworks();
    res.json(list.map((n) => ({ id: n.Id, name: n.Name, driver: n.Driver, scope: n.Scope })));
  } catch (err) { next(err); }
});

export default router;
