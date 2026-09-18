import { Router } from 'express';
import { listEndpoints, addEndpoint, updateEndpoint, deleteEndpoint, testEndpoint, inventory } from '../endpoints.js';

const router = Router();

// Aggregated read-only node/host inventory across all endpoints.
router.get('/inventory', async (req, res, next) => {
  try { res.json(await inventory()); } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try { res.json(await listEndpoints()); } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try { res.json(await addEndpoint(req.body || {})); } catch (err) { next(err); }
});

// Test an unsaved connection definition (before saving).
router.post('/test', async (req, res, next) => {
  try {
    const body = req.body || {};
    res.json(await testEndpoint({ conn: body.conn || body, name: body.name }));
  } catch (err) { next(err); }
});

router.post('/:id/test', async (req, res, next) => {
  try { res.json(await testEndpoint(req.params.id)); } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try { res.json(await updateEndpoint(req.params.id, req.body || {})); } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try { res.json(await deleteEndpoint(req.params.id)); } catch (err) { next(err); }
});

export default router;
