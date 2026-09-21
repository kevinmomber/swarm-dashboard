import { Router } from 'express';
import {
  deployTailscaleStack,
  removeTailscaleStack,
  tailscaleStackStatus,
  buildTailscaleCompose,
  tsConfig,
} from '../tailscale.js';
import { loadSettings } from '../settings.js';

const router = Router();

// Status of the deployed Tailscale/DockTail stack.
router.get('/status', async (req, res, next) => {
  try { res.json(await tailscaleStackStatus()); } catch (err) { next(err); }
});

// Preview the generated compose (secrets referenced by file, never inlined).
router.get('/compose', async (req, res, next) => {
  try {
    const settings = await loadSettings();
    const ts = tsConfig(settings);
    const secretFiles = {};
    if (ts.authKey) secretFiles.authKey = '/run/secrets-src/ts_authkey';
    if (ts.oauthClientSecret) secretFiles.oauthSecret = '/run/secrets-src/ts_oauth_secret';
    res.type('text/plain').send(buildTailscaleCompose(ts, secretFiles));
  } catch (err) { next(err); }
});

// Deploy (create + start) the stack.
router.post('/deploy', async (req, res, next) => {
  try { res.json(await deployTailscaleStack()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Remove the stack (optional ?purgeState=true).
router.delete('/stack', async (req, res, next) => {
  try { res.json(await removeTailscaleStack({ purgeState: req.query.purgeState === 'true' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

export default router;
