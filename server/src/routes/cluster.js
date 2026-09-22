import { Router } from 'express';
import {
  listContainers,
  containerAction,
  getContainerConfig,
  recreateContainerOnNode,
  containerTopOnNode,
  imageHistoryOnNode,
  fsListOnNode,
  fsReadOnNode,
  fsOpOnNode,
  listImages,
  imageAction,
  imagePrune,
  imageExport,
  imageImport,
  imageImportMulti,
  imageUsage,
  imagePull,
} from '../cluster.js';

const router = Router();

/* containers */
router.get('/containers', async (req, res, next) => {
  try { res.json(await listContainers()); } catch (err) { next(err); }
});
router.post('/containers/action', async (req, res, next) => {
  try {
    const { nodeId, id, action } = req.body || {};
    if (!id || !action) return res.status(400).json({ error: 'id und action erforderlich' });
    res.json(await containerAction(nodeId, id, action));
  } catch (err) { next(err); }
});
router.get('/containers/config', async (req, res, next) => {
  try {
    const { nodeId, id } = req.query;
    if (!id) return res.status(400).json({ error: 'id erforderlich' });
    res.json(await getContainerConfig(nodeId, id));
  } catch (err) { next(err); }
});
router.post('/containers/recreate', async (req, res, next) => {
  try {
    const { nodeId, id, patch } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id erforderlich' });
    res.json(await recreateContainerOnNode(nodeId, id, patch || {}));
  } catch (err) { next(err); }
});
// Running processes inside a container (ps aux).
router.get('/containers/top', async (req, res, next) => {
  try {
    const { nodeId, id, ps } = req.query;
    if (!id) return res.status(400).json({ error: 'id erforderlich' });
    res.json(await containerTopOnNode(nodeId, id, ps || 'aux'));
  } catch (err) { next(err); }
});
// Image layer history for a container/service image.
router.get('/containers/image-history', async (req, res, next) => {
  try {
    const { nodeId, ref } = req.query;
    if (!ref) return res.status(400).json({ error: 'ref erforderlich' });
    res.json(await imageHistoryOnNode(nodeId, ref));
  } catch (err) { next(err); }
});
// Filesystem browser inside a container.
router.get('/containers/fs/list', async (req, res, next) => {
  try {
    const { nodeId, id, path } = req.query;
    if (!id) return res.status(400).json({ error: 'id erforderlich' });
    res.json(await fsListOnNode(nodeId, id, path || '/'));
  } catch (err) { next(err); }
});
router.get('/containers/fs/read', async (req, res, next) => {
  try {
    const { nodeId, id, path } = req.query;
    if (!id || !path) return res.status(400).json({ error: 'id und path erforderlich' });
    res.json(await fsReadOnNode(nodeId, id, path));
  } catch (err) { next(err); }
});
router.post('/containers/fs/op', async (req, res, next) => {
  try {
    const { nodeId, id, op, path, contentB64 } = req.body || {};
    if (!id || !op || !path) return res.status(400).json({ error: 'id, op, path erforderlich' });
    res.json(await fsOpOnNode(nodeId, id, op, path, contentB64));
  } catch (err) { next(err); }
});

/* images */
router.get('/images', async (req, res, next) => {
  try { res.json(await listImages()); } catch (err) { next(err); }
});
router.get('/images/usage', async (req, res, next) => {
  try {
    const { nodeId, id, ref } = req.query;
    if (!id && !ref) return res.status(400).json({ error: 'id oder ref erforderlich' });
    res.json(await imageUsage(nodeId, id, ref));
  } catch (err) { next(err); }
});
router.post('/images/action', async (req, res, next) => {
  try {
    const { nodeId, id, action, force } = req.body || {};
    if (!id || !action) return res.status(400).json({ error: 'id und action erforderlich' });
    res.json(await imageAction(nodeId, id, action, force));
  } catch (err) { next(err); }
});
router.post('/images/prune', async (req, res, next) => {
  try {
    const { nodeId, all } = req.body || {};
    res.json(await imagePrune(nodeId, all));
  } catch (err) { next(err); }
});
router.get('/images/export', async (req, res, next) => {
  try {
    const { nodeId, image } = req.query;
    if (!image) return res.status(400).json({ error: 'image erforderlich' });
    await imageExport(nodeId, image, res);
  } catch (err) {
    if (!res.headersSent) next(err); else res.destroy();
  }
});
// Raw tar upload (Content-Type: application/x-tar) — streamed to the node's agent.
router.post('/images/import', async (req, res, next) => {
  try {
    await imageImport(req.query.nodeId, req, res);
  } catch (err) { next(err); }
});
// Raw tar upload fanned out to multiple nodes at once (?nodeIds=a,b,c).
router.post('/images/import-multi', async (req, res, next) => {
  try {
    const ids = String(req.query.nodeIds || '').split(',').map((s) => s.trim()).filter(Boolean);
    await imageImportMulti(ids, req, res);
  } catch (err) { next(err); }
});

// Pull an image from a registered registry onto one or more nodes (SSE progress).
router.post('/images/pull', async (req, res) => {
  const { ref, nodeIds } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
  try {
    const result = await imagePull({ ref, nodeIds, onEvent: (e) => send(e) });
    send({ type: 'done', result });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

export default router;
