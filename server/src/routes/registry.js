import { Router } from 'express';
import crypto from 'node:crypto';
import { docker } from '../docker.js';
import { loadSettings, saveSettings, redact } from '../settings.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const s = redact(await loadSettings());
    res.json(s.registries || []);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, url, username, password } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Registry-URL erforderlich' });
    const settings = await loadSettings();
    settings.registries = settings.registries || [];
    const rec = { id: crypto.randomUUID(), name: name || url, url, username: username || '', password: password || '' };
    settings.registries.push(rec);
    await saveSettings(settings);
    const { password: _pw, ...safe } = rec;
    res.json({ ...safe, hasPassword: Boolean(rec.password) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const settings = await loadSettings();
    settings.registries = (settings.registries || []).filter((r) => r.id !== req.params.id);
    await saveSettings(settings);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Validate credentials against the registry.
router.post('/:id/test', async (req, res, next) => {
  try {
    const settings = await loadSettings();
    const reg = (settings.registries || []).find((r) => r.id === req.params.id);
    if (!reg) return res.status(404).json({ error: 'Registry nicht gefunden' });
    const result = await docker.checkAuth({
      username: reg.username, password: reg.password, serveraddress: reg.url,
    });
    res.json({ ok: true, status: result?.Status || 'Login erfolgreich' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
