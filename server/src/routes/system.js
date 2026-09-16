import { Router } from 'express';
import { systemInfo, checkUpdate, selfUpdate } from '../system.js';

const router = Router();

router.get('/version', async (req, res, next) => {
  try { res.json(await systemInfo()); } catch (err) { next(err); }
});

router.post('/check-update', async (req, res, next) => {
  try { res.json(await checkUpdate()); } catch (err) { next(err); }
});

router.post('/update', async (req, res, next) => {
  try { res.json(await selfUpdate()); } catch (err) { next(err); }
});

export default router;
