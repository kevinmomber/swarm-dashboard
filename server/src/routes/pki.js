import { Router } from 'express';
import {
  getCaStatus,
  createCa,
  getCaCertPem,
  resetPki,
  issueCert,
  listCerts,
  getCert,
  certDownload,
  bundlePkcs12,
  deleteCert,
  revokeCert,
  getCrlPem,
  crlStatus,
} from '../pki.js';
import { reconcilePkiProxy } from '../proxy.js';

const router = Router();

const attach = (res, filename, body, mime = 'application/x-pem-file') => {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(body);
};

/* ----- CA ----- */

router.get('/ca', async (req, res, next) => {
  try { res.json(await getCaStatus()); } catch (err) { next(err); }
});

router.post('/ca', async (req, res, next) => {
  try {
    const { cn, org, days, bits } = req.body || {};
    res.json(await createCa({ cn, org, days, bits }));
  } catch (err) { next(err); }
});

router.delete('/ca', async (req, res, next) => {
  try {
    const r = await resetPki();
    const reconcile = await reconcilePkiProxy();
    res.json({ ...r, reconcile });
  } catch (err) { next(err); }
});

router.get('/ca/download', async (req, res, next) => {
  try {
    const pem = await getCaCertPem();
    attach(res, 'root-ca.pem', pem);
  } catch (err) { next(err); }
});

/* ----- CRL ----- */

router.get('/crl/status', async (req, res, next) => {
  try { res.json(await crlStatus()); } catch (err) { next(err); }
});

router.get('/crl', async (req, res, next) => {
  try {
    const pem = await getCrlPem();
    attach(res, 'crl.pem', pem);
  } catch (err) { next(err); }
});

/* ----- Leaf certificates ----- */

router.get('/certs', async (req, res, next) => {
  try { res.json(await listCerts()); } catch (err) { next(err); }
});

router.post('/certs', async (req, res, next) => {
  try {
    const { cn, sans, days, bits } = req.body || {};
    res.json(await issueCert({ cn, sans, days, bits }));
  } catch (err) { next(err); }
});

router.get('/certs/:id', async (req, res, next) => {
  try { res.json(await getCert(req.params.id)); } catch (err) { next(err); }
});

router.get('/certs/:id/download', async (req, res, next) => {
  try {
    const { filename, body } = await certDownload(req.params.id, String(req.query.fmt || 'cert'));
    attach(res, filename, body);
  } catch (err) { next(err); }
});

router.post('/certs/:id/p12', async (req, res, next) => {
  try {
    const { passphrase } = req.body || {};
    res.json(await bundlePkcs12(req.params.id, passphrase));
  } catch (err) { next(err); }
});

router.post('/certs/:id/revoke', async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const r = await revokeCert(req.params.id, reason || 'unspecified');
    const reconcile = await reconcilePkiProxy();
    res.json({ ...r, reconcile });
  } catch (err) { next(err); }
});

router.delete('/certs/:id', async (req, res, next) => {
  try {
    const r = await deleteCert(req.params.id);
    const reconcile = await reconcilePkiProxy();
    res.json({ ...r, reconcile });
  } catch (err) { next(err); }
});

export default router;
