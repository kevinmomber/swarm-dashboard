import { Router } from 'express';
import { clusterInfo } from '../docker.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    res.json(await clusterInfo());
  } catch (err) {
    next(err);
  }
});

export default router;
