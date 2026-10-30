import { Router } from 'express';
import { loadSettings, saveSettings, redact, applyPatch } from '../settings.js';
import { applySchedule } from '../backup.js';
import { applyMonitoring } from '../monitoring.js';

const THEMES = ['system', 'dark', 'light', 'glass', 'glass-dark', 'midnight', 'nord'];
const router = Router();

router.get('/', async (req, res, next) => {
  try {
    res.json(redact(await loadSettings()));
  } catch (err) {
    next(err);
  }
});

router.put('/', async (req, res, next) => {
  try {
    const current = await loadSettings();
    const merged = applyPatch(current, req.body || {});

    if (!THEMES.includes(merged.theme)) merged.theme = 'dark';
    const t = merged.backup?.target?.type;
    if (t !== 'local' && t !== 'smb') merged.backup.target.type = 'local';

    await saveSettings(merged);
    await applySchedule(); // reflect enable/schedule changes immediately
    await applyMonitoring(); // reflect monitoring changes immediately
    res.json(redact(merged));
  } catch (err) {
    next(err);
  }
});

export default router;
