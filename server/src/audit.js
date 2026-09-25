/**
 * Lightweight audit log for mutating API calls.
 *
 * Records who did what and when (method, path, actor, status, duration) into a
 * bounded JSON ring buffer on disk. Read-only requests are ignored. Sensitive
 * bodies are never stored — only the request line and outcome.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './settings.js';

const FILE = path.join(DATA_DIR, 'audit.json');
const MAX = 1000;

let cache = null;
let writing = false;
let dirty = false;

async function load() {
  if (cache) return cache;
  try { cache = JSON.parse(await readFile(FILE, 'utf8')); }
  catch { cache = []; }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

async function flush() {
  if (writing) { dirty = true; return; }
  writing = true;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(FILE, JSON.stringify(cache.slice(-MAX)), 'utf8');
  } catch { /* best-effort */ }
  writing = false;
  if (dirty) { dirty = false; flush(); }
}

/** Human-friendly action label from method + path. */
function describe(method, pathname) {
  const p = pathname.replace(/^\/api/, '');
  const seg = p.split('/').filter(Boolean);
  const map = {
    POST: 'erstellt/geändert', PUT: 'aktualisiert', DELETE: 'gelöscht', PATCH: 'geändert',
  };
  return `${map[method] || method} ${seg.join(' / ')}`;
}

// Paths that mutate but are noisy/irrelevant for an audit trail.
const IGNORE = [/^\/api\/auth\//, /^\/api\/security\/scan/, /\/logs?$/];

export async function record({ method, path: pathname, actor, status, ms, ip }) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return;
  if (IGNORE.some((re) => re.test(pathname))) return;
  const list = await load();
  list.push({
    at: new Date().toISOString(),
    method,
    path: pathname.replace(/^\/api/, ''),
    action: describe(method, pathname),
    actor: actor || 'anonymous',
    status,
    ms,
    ip: ip || null,
  });
  if (list.length > MAX) cache = list.slice(-MAX);
  flush();
}

/**
 * Record an authentication attempt (login success or failure). Unlike record(),
 * this bypasses the method/IGNORE gating so security-relevant auth events are
 * always captured — including failed logins, which are the ones that matter most
 * for spotting brute-force attempts. The attempted username is stored as the
 * actor even on failure (forensics); passwords are never recorded.
 */
export async function recordAuth({ event, username, status, ms, ip }) {
  const ok = status >= 200 && status < 300;
  const labels = {
    login: ok ? 'Login erfolgreich' : 'Login fehlgeschlagen',
    logout: 'Logout',
  };
  const list = await load();
  list.push({
    at: new Date().toISOString(),
    method: 'AUTH',
    path: `/auth/${event}`,
    action: labels[event] || `Auth ${event}`,
    actor: username || 'anonymous',
    status,
    ms: ms ?? null,
    ip: ip || null,
  });
  if (list.length > MAX) cache = list.slice(-MAX);
  flush();
}

/** Express middleware: audit every mutating request after it completes. */
export function auditMiddleware() {  return (req, res, next) => {
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
    const started = Date.now();
    res.on('finish', () => {
      record({
        method: req.method,
        path: req.originalUrl.split('?')[0],
        actor: req.user?.username || null,
        status: res.statusCode,
        ms: Date.now() - started,
        ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim() || null,
      });
    });
    next();
  };
}

export async function listAudit({ limit = 200 } = {}) {
  const list = await load();
  return list.slice(-limit).reverse();
}

export async function clearAudit() {
  cache = [];
  await flush();
  return { ok: true };
}
