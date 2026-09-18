import { Router } from 'express';
import { listAudit, clearAudit } from '../audit.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json(await listAudit({ limit }));
  } catch (err) { next(err); }
});

router.delete('/', async (req, res, next) => {
  try { res.json(await clearAudit()); } catch (err) { next(err); }
});

export default router;
