import { Router } from 'express';
import { securityTargets, scanImage } from '../cluster.js';
import { putResult, getResult, allResults, clearResults, scorecard } from '../securitystore.js';

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

export default router;
