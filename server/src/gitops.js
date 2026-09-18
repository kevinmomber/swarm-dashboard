/**
 * GitOps: keep a Swarm stack in sync with a compose file in a Git repository.
 *
 * Each entry references a configured Git repo (settings.git), a compose path
 * inside it, and a target stack name. A scheduler (or a manual "sync now")
 * shallow-clones the repo, reads the compose file, and — if its content changed
 * since the last successful deploy — runs `docker stack deploy`.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, saveSettings } from './settings.js';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
let timer = null;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `exit ${code}`))));
  });
}

/** Public (redacted) view of a gitops entry. */
function redact(e) {
  return {
    id: e.id, name: e.name, gitId: e.gitId, stackName: e.stackName, composePath: e.composePath,
    autoDeploy: Boolean(e.autoDeploy), intervalMin: e.intervalMin || 5,
    lastSha: e.lastSha || null, lastDeployedAt: e.lastDeployedAt || null,
    lastStatus: e.lastStatus || null, lastError: e.lastError || null, lastCheckedAt: e.lastCheckedAt || null,
  };
}

export async function listGitops() {
  const s = await loadSettings();
  return (s.gitops || []).map(redact);
}

export async function addGitops(input) {
  const s = await loadSettings();
  if (!input?.name || !NAME_RE.test(input.name)) throw new Error('Ungültiger Name');
  if (!input.gitId) throw new Error('Git-Repo erforderlich');
  if (!input.stackName || !NAME_RE.test(input.stackName)) throw new Error('Ungültiger Stack-Name');
  const entry = {
    id: randomBytes(6).toString('hex'),
    name: input.name.trim(), gitId: input.gitId,
    stackName: input.stackName.trim(),
    composePath: (input.composePath || 'docker-compose.yml').trim(),
    autoDeploy: Boolean(input.autoDeploy),
    intervalMin: Math.max(1, Number(input.intervalMin) || 5),
    lastSha: null, lastDeployedAt: null, lastStatus: null, lastError: null, lastCheckedAt: null,
  };
  s.gitops = [...(s.gitops || []), entry];
  await saveSettings(s);
  applyGitopsSchedule();
  return redact(entry);
}

export async function updateGitops(id, patch) {
  const s = await loadSettings();
  const e = (s.gitops || []).find((x) => x.id === id);
  if (!e) throw Object.assign(new Error('GitOps-Eintrag nicht gefunden'), { status: 404 });
  if (patch.name !== undefined) e.name = String(patch.name).trim();
  if (patch.gitId !== undefined) e.gitId = patch.gitId;
  if (patch.stackName !== undefined) e.stackName = String(patch.stackName).trim();
  if (patch.composePath !== undefined) e.composePath = String(patch.composePath).trim();
  if (patch.autoDeploy !== undefined) e.autoDeploy = Boolean(patch.autoDeploy);
  if (patch.intervalMin !== undefined) e.intervalMin = Math.max(1, Number(patch.intervalMin) || 5);
  await saveSettings(s);
  applyGitopsSchedule();
  return redact(e);
}

export async function deleteGitops(id) {
  const s = await loadSettings();
  s.gitops = (s.gitops || []).filter((x) => x.id !== id);
  await saveSettings(s);
  applyGitopsSchedule();
  return { ok: true };
}

function authUrl(repo) {
  let url = repo.url;
  if (repo.token && /^https:\/\//i.test(url)) url = url.replace(/^https:\/\//i, `https://${encodeURIComponent(repo.token)}@`);
  return url;
}

/** Sync one entry: clone, read compose, deploy if changed (or forced). */
export async function syncGitops(id, { force = false } = {}) {
  const s = await loadSettings();
  const e = (s.gitops || []).find((x) => x.id === id);
  if (!e) throw Object.assign(new Error('GitOps-Eintrag nicht gefunden'), { status: 404 });
  const repo = (s.git || []).find((g) => g.id === e.gitId);
  if (!repo) throw new Error('Verknüpftes Git-Repo nicht gefunden');

  let tmp;
  const result = { changed: false, deployed: false, sha: null, status: 'ok', error: null };
  try {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'gitops-'));
    await run('git', ['clone', '--depth', '1', '--branch', repo.branch || 'main', authUrl(repo), tmp]);
    const sha = await run('git', ['-C', tmp, 'rev-parse', 'HEAD']).catch(() => null);
    const composeFile = path.join(tmp, e.composePath);
    const compose = await readFile(composeFile, 'utf8');
    const hash = createHash('sha256').update(compose).digest('hex').slice(0, 16);
    result.sha = sha;
    result.changed = force || hash !== e.lastSha;

    if (result.changed) {
      const tmpYml = path.join(tmp, '.gitops-deploy.yml');
      await writeFile(tmpYml, compose, 'utf8');
      await run('docker', ['stack', 'deploy', '--detach=true', '--with-registry-auth', '-c', tmpYml, e.stackName]);
      result.deployed = true;
      e.lastSha = hash;
      e.lastDeployedAt = new Date().toISOString();
    }
    e.lastStatus = result.changed ? 'deployed' : 'unchanged';
    e.lastError = null;
  } catch (err) {
    result.status = 'error'; result.error = err.message;
    e.lastStatus = 'error'; e.lastError = err.message;
  } finally {
    e.lastCheckedAt = new Date().toISOString();
    await saveSettings(s);
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  return { ...result, entry: redact(e) };
}

/* --------------------------- scheduler --------------------------- */

export function applyGitopsSchedule() {
  if (timer) { clearInterval(timer); timer = null; }
  timer = setInterval(async () => {
    try {
      const s = await loadSettings();
      const now = Date.now();
      for (const e of s.gitops || []) {
        if (!e.autoDeploy) continue;
        const last = e.lastCheckedAt ? new Date(e.lastCheckedAt).getTime() : 0;
        if (now - last >= (e.intervalMin || 5) * 60_000) {
          await syncGitops(e.id).catch(() => {});
        }
      }
    } catch { /* ignore */ }
  }, 60_000);
  if (timer.unref) timer.unref();
}
