import { Router } from 'express';
import {
  listProxyServices,
  applyProxyToService,
  removeProxyFromService,
  setServiceMtls,
  reconcilePkiProxy,
  generateNginxConfig,
  buildProxyCompose,
  buildPkiProxyPlan,
  deployProxyStack,
  proxyStackStatus,
  removeProxyStack,
  proxyNetwork,
} from '../proxy.js';
import { loadSettings } from '../settings.js';

const router = Router();

// Status of the deployed proxy stack.
router.get('/status', async (req, res, next) => {
  try {
    res.json(await proxyStackStatus());
  } catch (err) { next(err); }
});

// Preview the generated proxy stack compose (no deploy).
router.get('/compose', async (req, res, next) => {
  try {
    const proxy = (await loadSettings()).reverseProxy;
    const nginxConf = proxy.type === 'nginx' ? '/etc/swarmdash/nginx.conf' : null;
    const dockerProxyConf = proxy.type === 'traefik' ? '/etc/swarmdash/dockerproxy.conf' : null;
    const pki = proxy.type === 'traefik' && proxy.tlsSource === 'internal-pki'
      ? await buildPkiProxyPlan(null) : null;
    const compose = await buildProxyCompose(proxy, nginxConf, dockerProxyConf, pki);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(compose);
  } catch (err) { next(err); }
});

// Reconcile Traefik with the current PKI state and prune orphaned pki configs.
router.post('/reconcile-pki', async (req, res, next) => {
  try {
    res.json(await reconcilePkiProxy());
  } catch (err) {
    next(err);
  }
});

// Deploy (create + start) the configured reverse proxy as a stack.
router.post('/deploy', async (req, res, next) => {
  try {
    res.json(await deployProxyStack());
  } catch (err) { next(err); }
});

// Remove the deployed proxy stack.
router.delete('/stack', async (req, res, next) => {
  try {
    res.json(await removeProxyStack());
  } catch (err) { next(err); }
});

// Services tagged for reverse-proxy use.
router.get('/services', async (req, res, next) => {
  try {
    res.json(await listProxyServices());
  } catch (err) {
    next(err);
  }
});

// Apply Traefik labels to a service.
router.post('/apply/:id', async (req, res, next) => {
  try {
    res.json(await applyProxyToService(req.params.id));
  } catch (err) {
    next(err);
  }
});

// Remove reverse-proxy tagging from a service (labels + network detach).
router.delete('/apply/:id', async (req, res, next) => {
  try {
    res.json(await removeProxyFromService(req.params.id));
  } catch (err) {
    next(err);
  }
});

// Set per-service mTLS mode (off|optional|require).
router.post('/mtls/:id', async (req, res, next) => {
  try {
    res.json(await setServiceMtls(req.params.id, (req.body && req.body.mode) || 'off'));
  } catch (err) {
    next(err);
  }
});

// Generate nginx config for all tagged services (download).
router.get('/nginx-config', async (req, res, next) => {
  try {
    const cfg = await generateNginxConfig();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="swarm-dashboard.conf"');
    res.send(cfg);
  } catch (err) {
    next(err);
  }
});

export default router;
