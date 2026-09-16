/**
 * Integrated image Builder (CI/CD).
 *
 * Builds container images from a Dockerfile directly on the manager's Docker
 * daemon using BuildKit (docker buildx / `docker build`), streaming the build
 * logs live. Optionally pushes the result to a configured registry. Also
 * exposes build-cache pruning. Saved Dockerfiles and a short build history are
 * persisted in settings.
 *
 * Note: a build runs on the manager node's daemon, so the resulting image only
 * exists there. To run it across the Swarm, push it to a registry and reference
 * that tag — which is exactly what the integrated push step is for.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, saveSettings } from './settings.js';
import { requireManager } from './docker.js';
import { registryHost } from './registryauth.js';

const HISTORY_MAX = 30;
const VALID_TAG = /^[a-zA-Z0-9][\w.\-/:@]*$/;

/* ------------------------------------------------------------------ */
/* persistence                                                        */
/* ------------------------------------------------------------------ */

function ensureBuilder(settings) {
  settings.builder = settings.builder || { dockerfiles: [], history: [] };
  settings.builder.dockerfiles = settings.builder.dockerfiles || [];
  settings.builder.history = settings.builder.history || [];
  return settings.builder;
}

export async function listBuilder() {
  const b = ensureBuilder(await loadSettings());
  return {
    dockerfiles: b.dockerfiles,
    history: [...b.history].slice(-HISTORY_MAX).reverse(),
  };
}

export async function saveDockerfile({ id, name, content }) {
  if (!name || !String(name).trim()) throw new Error('Name erforderlich');
  const settings = await loadSettings();
  const b = ensureBuilder(settings);
  const now = new Date().toISOString();
  if (id) {
    const rec = b.dockerfiles.find((d) => d.id === id);
    if (!rec) throw new Error('Dockerfile nicht gefunden');
    rec.name = String(name).trim();
    rec.content = String(content ?? '');
    rec.updatedAt = now;
    await saveSettings(settings);
    return rec;
  }
  const rec = { id: crypto.randomUUID(), name: String(name).trim(), content: String(content ?? ''), updatedAt: now };
  b.dockerfiles.push(rec);
  await saveSettings(settings);
  return rec;
}

export async function deleteDockerfile(id) {
  const settings = await loadSettings();
  const b = ensureBuilder(settings);
  const before = b.dockerfiles.length;
  b.dockerfiles = b.dockerfiles.filter((d) => d.id !== id);
  if (b.dockerfiles.length === before) throw new Error('Dockerfile nicht gefunden');
  await saveSettings(settings);
  return { ok: true };
}

async function addHistory(entry) {
  const settings = await loadSettings();
  const b = ensureBuilder(settings);
  b.history.push(entry);
  if (b.history.length > HISTORY_MAX * 2) b.history = b.history.slice(-HISTORY_MAX);
  await saveSettings(settings);
}

/* ------------------------------------------------------------------ */
/* process streaming helper                                           */
/* ------------------------------------------------------------------ */

/**
 * Spawn a command and stream stdout+stderr line-by-line to onLine. Optional
 * `input` is written to stdin (used for `docker login --password-stdin`).
 * Resolves on exit 0, rejects otherwise.
 */
function runStream(cmd, args, { cwd, env, input } = {}, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let buf = '';
    const pump = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', (e) => reject(new Error(`${cmd} nicht verfügbar: ${e.message}`)));
    child.on('close', (code) => {
      if (buf.length) onLine(buf.replace(/\r$/, ''));
      if (code === 0) resolve();
      else reject(new Error(`${cmd} beendet mit Exit-Code ${code}`));
    });
    if (input != null) { child.stdin.write(input); }
    child.stdin.end();
  });
}

/* ------------------------------------------------------------------ */
/* build + push                                                       */
/* ------------------------------------------------------------------ */

function parseBuildArgs(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out.push('--build-arg', t);
  }
  return out;
}

/** Clone a configured git repo (token-injected over HTTPS) into destDir. */
async function cloneGitContext(repo, destDir, onLine) {
  let url = repo.url;
  if (repo.token && /^https:\/\//i.test(url)) {
    url = url.replace(/^https:\/\//i, `https://${encodeURIComponent(repo.token)}@`);
  }
  onLine(`> git clone --depth 1 --branch ${repo.branch} ${repo.url}`);
  await runStream('git', ['clone', '--depth', '1', '--branch', repo.branch, url, destDir], {}, () => {});
}

/**
 * Build an image and optionally push it. Streams events via `send`:
 *   { type:'log', line } | { type:'phase', phase } | { type:'built'|'pushed' }
 *   | { type:'done', status } | { type:'error', message }
 */
export async function buildAndPush(opts, send) {
  const {
    dockerfile, tag, buildArgs, noCache,
    contextGitId, contextPath, pushRegistryId,
  } = opts || {};

  const startedAt = new Date().toISOString();
  const record = { id: crypto.randomUUID(), tag: tag || '', startedAt, finishedAt: null, status: 'running', pushed: false, error: null };
  let tmp;
  try {
    await requireManager();
    const cleanTag = String(tag || '').trim();
    if (!cleanTag || !VALID_TAG.test(cleanTag)) throw new Error('Ungültiger oder fehlender Image-Tag (z. B. myapp:1.0 oder registry.example.com/team/app:1.0)');
    if (!String(dockerfile || '').trim()) throw new Error('Dockerfile ist leer');

    const settings = await loadSettings();
    tmp = await mkdtemp(path.join(os.tmpdir(), 'swarmbuild-'));

    // Resolve the build context directory.
    let contextDir = tmp;
    if (contextGitId) {
      const repo = (settings.git || []).find((g) => g.id === contextGitId);
      if (!repo) throw new Error('Git-Kontext-Repository nicht gefunden');
      const cloneDir = path.join(tmp, 'ctx');
      send({ type: 'phase', phase: 'context' });
      await cloneGitContext(repo, cloneDir, (l) => send({ type: 'log', line: l }));
      contextDir = contextPath ? path.join(cloneDir, contextPath) : cloneDir;
    }

    // Write the (edited) Dockerfile into the context dir so BuildKit accepts it.
    const dfPath = path.join(contextDir, '.swarmdash.Dockerfile');
    await writeFile(dfPath, String(dockerfile), 'utf8');

    const args = ['build', '-t', cleanTag, '-f', dfPath];
    if (noCache) args.push('--no-cache');
    args.push('--progress=plain');
    args.push(...parseBuildArgs(buildArgs));
    args.push(contextDir);

    send({ type: 'phase', phase: 'build' });
    send({ type: 'log', line: `> docker ${args.join(' ')}` });
    await runStream('docker', args, { env: { DOCKER_BUILDKIT: '1' } }, (line) => send({ type: 'log', line }));
    send({ type: 'built', tag: cleanTag });

    // Optional push to a configured registry.
    if (pushRegistryId) {
      const reg = (settings.registries || []).find((r) => r.id === pushRegistryId);
      if (!reg) throw new Error('Push-Registry nicht gefunden');
      const host = registryHost(reg.url ? reg.url.replace(/^https?:\/\//, '') + '/x' : cleanTag);
      send({ type: 'phase', phase: 'push' });
      if (reg.username) {
        send({ type: 'log', line: `> docker login ${host} -u ${reg.username}` });
        await runStream('docker', ['login', host, '-u', reg.username, '--password-stdin'],
          { input: reg.password || '' }, (line) => send({ type: 'log', line }));
      }
      send({ type: 'log', line: `> docker push ${cleanTag}` });
      await runStream('docker', ['push', cleanTag], {}, (line) => send({ type: 'log', line }));
      record.pushed = true;
      send({ type: 'pushed', tag: cleanTag });
    }

    record.status = 'success';
    record.finishedAt = new Date().toISOString();
    await addHistory(record);
    send({ type: 'done', status: 'success', pushed: record.pushed });
  } catch (e) {
    record.status = 'error';
    record.error = e.message;
    record.finishedAt = new Date().toISOString();
    await addHistory(record).catch(() => {});
    send({ type: 'error', message: e.message });
    send({ type: 'done', status: 'error' });
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Prune the BuildKit build cache, streaming output. */
export async function pruneBuildCache(send) {
  try {
    await requireManager();
    send({ type: 'log', line: '> docker builder prune -f' });
    await runStream('docker', ['builder', 'prune', '-f'], { env: { DOCKER_BUILDKIT: '1' } }, (line) => send({ type: 'log', line }));
    send({ type: 'done', status: 'success' });
  } catch (e) {
    send({ type: 'error', message: e.message });
    send({ type: 'done', status: 'error' });
  }
}
