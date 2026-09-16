import { Router } from 'express';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, saveSettings, redact } from '../settings.js';

const router = Router();

function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: process.env, ...opts });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`git nicht verfügbar: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `git exit ${code}`))));
  });
}

router.get('/', async (req, res, next) => {
  try {
    const s = redact(await loadSettings());
    res.json(s.git || []);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, url, branch, composePath, token } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Repository-URL erforderlich' });
    const settings = await loadSettings();
    settings.git = settings.git || [];
    const rec = {
      id: crypto.randomUUID(), name: name || url, url,
      branch: branch || 'main', composePath: composePath || 'docker-compose.yml', token: token || '',
    };
    settings.git.push(rec);
    await saveSettings(settings);
    const { token: _t, ...safe } = rec;
    res.json({ ...safe, hasToken: Boolean(rec.token) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const settings = await loadSettings();
    settings.git = (settings.git || []).filter((g) => g.id !== req.params.id);
    await saveSettings(settings);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Clone (shallow) and return the compose file content for review/deploy.
router.post('/:id/fetch', async (req, res, next) => {
  let tmp;
  try {
    const settings = await loadSettings();
    const repo = (settings.git || []).find((g) => g.id === req.params.id);
    if (!repo) return res.status(404).json({ error: 'Repository nicht gefunden' });

    let url = repo.url;
    if (repo.token && /^https:\/\//i.test(url)) {
      url = url.replace(/^https:\/\//i, `https://${encodeURIComponent(repo.token)}@`);
    }
    tmp = await mkdtemp(path.join(os.tmpdir(), 'gitstack-'));
    await runGit(['clone', '--depth', '1', '--branch', repo.branch, url, tmp]);
    const composeFile = path.join(tmp, repo.composePath);
    const compose = await readFile(composeFile, 'utf8');
    res.json({ compose, composePath: repo.composePath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

export default router;
