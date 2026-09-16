import { Router } from 'express';
import { getStatus, testAlert } from '../monitoring.js';

const router = Router();

router.get('/status', async (req, res, next) => {
  try { res.json(await getStatus()); } catch (err) { next(err); }
});

router.post('/test', async (req, res, next) => {
  try { res.json(await testAlert()); } catch (err) { next(err); }
});

export default router;
