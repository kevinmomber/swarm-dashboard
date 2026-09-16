import { Router } from 'express';
import { loadSettings, redact } from '../settings.js';
import {
  listBackupServices,
  runBackup,
  testTarget,
  isRunning,
  listArchives,
  restoreArchive,
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
    res.json({ running: isRunning(), history: s.history || [] });
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
    const { volume, file, clean } = req.body || {};
    res.json(await restoreArchive({ volume, file, clean: Boolean(clean) }));
  } catch (err) {
    next(err);
  }
});

export default router;
