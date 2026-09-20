import { Router } from 'express';
import { docker, requireManager } from '../docker.js';
import {
  vaultStatus, initVault, unlockVault, changePassphrase, destroyVault,
  putEntry, removeEntry, exportVault, importVault, recreateSecrets,
} from '../secretvault.js';

const router = Router();

// Public status: whether a vault exists + entry names/metadata (never values).
router.get('/status', async (req, res, next) => {
  try { res.json(await vaultStatus()); } catch (err) { next(err); }
});

// Initialize a new vault with a passphrase.
router.post('/init', async (req, res, next) => {
  try { res.json(await initVault(req.body?.passphrase)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Validate a passphrase.
router.post('/unlock', async (req, res, next) => {
  try { res.json(await unlockVault(req.body?.passphrase)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Change passphrase (re-encrypts all entries).
router.post('/passphrase', async (req, res, next) => {
  try { res.json(await changePassphrase(req.body?.oldPassphrase, req.body?.newPassphrase)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Add/overwrite an entry.
router.post('/entry', async (req, res, next) => {
  try {
    const { passphrase, name, value, valueB64, labels } = req.body || {};
    res.json(await putEntry({ passphrase, name, value, valueB64, labels }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Remove an entry (vault only; does not touch Docker).
router.delete('/entry/:name', async (req, res, next) => {
  try { res.json(await removeEntry(req.params.name)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Download the encrypted vault file.
router.get('/export', async (req, res, next) => {
  try {
    const json = await exportVault();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="secret-vault-${new Date().toISOString().slice(0, 10)}.json"`);
    res.end(json);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Import a vault file (mode: replace | merge).
router.post('/import', async (req, res, next) => {
  try {
    const { content, mode, passphrase } = req.body || {};
    res.json(await importVault({ content, mode, passphrase }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Recreate selected/all secrets as Docker secrets.
router.post('/recreate', async (req, res, next) => {
  try {
    await requireManager();
    const { passphrase, names, replaceExisting } = req.body || {};
    res.json(await recreateSecrets({ passphrase, names, docker, replaceExisting: Boolean(replaceExisting) }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Destroy the whole vault.
router.delete('/', async (req, res, next) => {
  try { res.json(await destroyVault()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

export default router;
