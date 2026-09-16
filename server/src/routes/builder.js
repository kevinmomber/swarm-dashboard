import { Router } from 'express';
import {
  listBuilder, saveDockerfile, deleteDockerfile, buildAndPush, pruneBuildCache,
} from '../builder.js';

const router = Router();

// Open an SSE response and return a `send(obj)` helper.
function sse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  return (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
}

// Saved Dockerfiles + recent build history.
router.get('/', async (req, res, next) => {
  try { res.json(await listBuilder()); } catch (err) { next(err); }
});

router.post('/dockerfiles', async (req, res, next) => {
  try {
    const { id, name, content } = req.body || {};
    res.json(await saveDockerfile({ id, name, content }));
  } catch (err) { next(err); }
});

router.delete('/dockerfiles/:id', async (req, res, next) => {
  try { res.json(await deleteDockerfile(req.params.id)); } catch (err) { next(err); }
});

// Build (and optionally push) an image, streaming logs via SSE.
router.post('/build', async (req, res) => {
  const send = sse(res);
  try {
    await buildAndPush(req.body || {}, send);
  } catch (e) {
    send({ type: 'error', message: e.message });
    send({ type: 'done', status: 'error' });
  }
  res.end();
});

// Prune the BuildKit build cache, streaming output via SSE.
router.post('/prune-cache', async (req, res) => {
  const send = sse(res);
  try {
    await pruneBuildCache(send);
  } catch (e) {
    send({ type: 'error', message: e.message });
    send({ type: 'done', status: 'error' });
  }
  res.end();
});

export default router;
