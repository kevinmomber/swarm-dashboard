import { Router } from 'express';
import { securityTargets, scanImage } from '../cluster.js';
import { putResult, getResult, allResults, clearResults, scorecard } from '../securitystore.js';
import { runBestPractices } from '../bestpractices.js';
import { history as bpHistory, runNow as bpRunNow, applyBestPracticeSchedule, scheduleStatus } from '../bpstore.js';
import { loadSettings, saveSettings } from '../settings.js';

const router = Router();

// Current state: scannable targets + cached results + aggregate scorecard.
router.get('/', async (req, res, next) => {
  try {
    const targets = await securityTargets();
    const byKey = new Map(allResults().map((r) => [`${r.nodeId || ''}|${r.ref}`, r]));
    const items = targets.map((t) => {
      const cached = byKey.get(`${t.nodeId || ''}|${t.ref}`);
      return { ...t, result: cached || null };
    });
    res.json({ targets: items, scorecard: scorecard() });
  } catch (err) { next(err); }
});

// Single cached result (with full CVE list).
router.get('/result', async (req, res, next) => {
  try {
    const { nodeId, ref } = req.query;
    if (!ref) return res.status(400).json({ error: 'ref erforderlich' });
    res.json(getResult(nodeId, ref) || {});
  } catch (err) { next(err); }
});

router.post('/clear', async (req, res) => { clearResults(); res.json({ ok: true }); });

// Scan a set of targets, streaming progress via SSE.
router.post('/scan', async (req, res) => {
  let targets = (req.body && req.body.targets) || null;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };

  try {
    if (!targets) {
      const all = await securityTargets();
      targets = all.filter((t) => !t.dangling).map((t) => ({ nodeId: t.nodeId, ref: t.ref, node: t.node }));
    }
    send({ type: 'start', total: targets.length });
    let done = 0;
    for (const t of targets) {
      send({ type: 'scanning', ref: t.ref, node: t.node || null, done, total: targets.length });
      try {
        const summary = await scanImage(t.nodeId, t.ref);
        putResult(t.nodeId, t.node || summary.hostname || null, t.ref, summary);
        send({
          type: 'result', ref: t.ref, node: t.node || null,
          severities: summary.severities, total: summary.total, grade: summary.grade, score: summary.score,
        });
      } catch (e) {
        putResult(t.nodeId, t.node || null, t.ref, { error: e.message });
        send({ type: 'result', ref: t.ref, node: t.node || null, error: e.message });
      }
      done++;
      send({ type: 'progress', done, total: targets.length });
    }
    send({ type: 'done', scorecard: scorecard() });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

// Best-practice scan of the swarm manager (read-only; infra + security rules).
router.get('/best-practices', async (req, res, next) => {
  try {
    res.json(await runBestPractices());
  } catch (err) { next(err); }
});

// Manual run that also records the result into the score history.
router.post('/best-practices/run', async (req, res, next) => {
  try {
    res.json(await bpRunNow());
  } catch (err) { next(err); }
});

// Score history (time-series of recorded runs).
router.get('/best-practices/history', async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(180, Number(req.query.days) || 30));
    res.json(bpHistory({ days }));
  } catch (err) { next(err); }
});

// Schedule config + status.
router.get('/best-practices/schedule', async (req, res, next) => {
  try {
    const settings = await loadSettings();
    res.json({ config: settings.bestPractices, status: scheduleStatus() });
  } catch (err) { next(err); }
});

router.post('/best-practices/schedule', async (req, res, next) => {
  try {
    const body = req.body || {};
    const settings = await loadSettings();
    const cur = settings.bestPractices || {};
    settings.bestPractices = {
      ...cur,
      enabled: body.enabled != null ? Boolean(body.enabled) : cur.enabled,
      intervalHours: body.intervalHours != null ? Math.max(1, Math.min(168, Number(body.intervalHours) || 24)) : cur.intervalHours,
      alertOnNewCritical: body.alertOnNewCritical != null ? Boolean(body.alertOnNewCritical) : cur.alertOnNewCritical,
      alertOnGradeDrop: body.alertOnGradeDrop != null ? Boolean(body.alertOnGradeDrop) : cur.alertOnGradeDrop,
    };
    await saveSettings(settings);
    const status = await applyBestPracticeSchedule();
    res.json({ config: settings.bestPractices, status });
  } catch (err) { next(err); }
});

export default router;
