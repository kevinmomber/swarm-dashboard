import { Router } from 'express';
import { loadSettings, redact } from '../settings.js';
import {
  listBackupServices,
  runBackup,
  testTarget,
  isRunning,
  listArchives,
  restoreArchive,
  getActiveManager,
  listServiceSpecs,
  readServiceSpec,
  restoreServiceSpec,
  restoreServiceFull,
} from '../backup.js';

const router = Router();

// Services tagged for backup (+ volumes). Optional ?tag= to filter by job tag.
router.get('/services', async (req, res, next) => {
  try {
    res.json(await listBackupServices(req.query.tag));
  } catch (err) {
    next(err);
  }
});

// Lightweight list of configured backup jobs (id, name, tag) for assignment UIs.
router.get('/jobs', async (req, res, next) => {
  try {
    const s = await loadSettings();
    const jobs = (s.backup?.jobs || []).map((j) => ({ id: j.id, name: j.name, tag: j.tag, enabled: !!j.enabled }));
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    const s = redact(await loadSettings());
    const manager = await getActiveManager().catch(() => null);
    res.json({ running: isRunning(), manager, history: s.history || [] });
  } catch (err) {
    next(err);
  }
});

// Trigger a backup now (a specific job, or the default).
router.post('/run', async (req, res, next) => {
  try {
    const jobId = req.body?.jobId || 'default';
    res.json(await runBackup({ jobId, trigger: 'manual' }));
  } catch (err) {
    next(err);
  }
});

// Trigger a backup now and stream live progress (SSE) per volume.
router.post('/run-stream', async (req, res) => {
  const jobId = req.body?.jobId || 'default';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
  try {
    const entry = await runBackup({
      jobId, trigger: 'manual',
      onProgress: (ev) => send(ev),
    });
    send({ type: 'done', entry });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

router.post('/test-target', async (req, res, next) => {
  try {
    const target = req.body && req.body.type ? req.body : undefined;
    res.json(await testTarget(target));
  } catch (err) {
    next(err);
  }
});

// Archives available in the target, grouped by volume.
router.get('/archives', async (req, res, next) => {
  try {
    res.json(await listArchives());
  } catch (err) {
    next(err);
  }
});

// Restore an archive into its volume.
router.post('/restore', async (req, res, next) => {
  try {
    const { volume, file, clean, nodeId } = req.body || {};
    res.json(await restoreArchive({ volume, file, clean: Boolean(clean), nodeId: nodeId || null }));
  } catch (err) {
    next(err);
  }
});

// Saved service specs in the target, grouped by service name.
router.get('/service-specs', async (req, res, next) => {
  try {
    res.json(await listServiceSpecs());
  } catch (err) {
    next(err);
  }
});

// Full content of one saved service spec (for viewing).
router.get('/service-spec', async (req, res, next) => {
  try {
    res.json(await readServiceSpec(req.query.file));
  } catch (err) {
    next(err);
  }
});

// Recreate/update a service from a saved spec (configuration only).
router.post('/restore-service', async (req, res, next) => {
  try {
    const { file } = req.body || {};
    if (!file) return res.status(400).json({ error: 'file erforderlich' });
    res.json(await restoreServiceSpec({ file }));
  } catch (err) {
    next(err);
  }
});

// Combined restore: recreate service + restore its volume data (SSE progress).
router.post('/restore-service-full', async (req, res) => {
  const { file, clean } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
  try {
    if (!file) throw new Error('file erforderlich');
    const result = await restoreServiceFull({ file, clean: clean !== false, onProgress: (ev) => send(ev) });
    send({ type: 'done', result });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

export default router;
