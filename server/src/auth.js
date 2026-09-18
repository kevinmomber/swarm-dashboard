import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './settings.js';

const FILE = path.join(DATA_DIR, 'auth.json');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h
let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    cache = { enabled: false, secret: crypto.randomBytes(32).toString('hex'), users: [] };
  }
  if (!cache.secret) cache.secret = crypto.randomBytes(32).toString('hex');
  return cache;
}
async function persist() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(cache, null, 2), 'utf8');
}
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

export async function isEnabled() {
  return (await load()).enabled;
}
export async function authStatus() {
  const a = await load();
  return { enabled: a.enabled, hasUsers: a.users.length > 0 };
}
export async function setEnabled(v) {
  const a = await load();
  if (v && a.users.length === 0) throw new Error('Bitte zuerst einen Benutzer anlegen');
  a.enabled = Boolean(v);
  await persist();
  return { enabled: a.enabled };
}
export async function listUsers() {
  const a = await load();
  return a.users.map((u) => ({ username: u.username, role: u.role, createdAt: u.createdAt }));
}
export async function createUser(username, password, role = 'admin') {
  const a = await load();
  if (!username || !password) throw new Error('username und password erforderlich');
  if (a.users.some((u) => u.username === username)) throw new Error('Benutzer existiert bereits');
  const validRole = ['admin', 'operator', 'viewer'].includes(role) ? role : 'admin';
  const salt = crypto.randomBytes(16).toString('hex');
  a.users.push({ username, salt, hash: hash(password, salt), role: validRole, createdAt: new Date().toISOString() });
  await persist();
  return { username, role: validRole };
}
export async function deleteUser(username) {
  const a = await load();
  a.users = a.users.filter((u) => u.username !== username);
  if (a.users.length === 0) a.enabled = false;
  await persist();
}
export async function changePassword(username, newPw) {
  const a = await load();
  const u = a.users.find((x) => x.username === username);
  if (!u) throw new Error('Benutzer nicht gefunden');
  if (!newPw) throw new Error('Passwort erforderlich');
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = hash(newPw, u.salt);
  await persist();
}
export async function verifyLogin(username, password) {
  const a = await load();
  const u = a.users.find((x) => x.username === username);
  if (!u) return null;
  const h = hash(password, u.salt);
  const ok = h.length === u.hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash));
  return ok ? { username: u.username, role: u.role } : null;
}

/* -------- HMAC token (stateless) -------- */
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', cache.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export async function issueToken(user) {
  await load();
  return sign({ username: user.username, role: user.role, exp: Date.now() + TOKEN_TTL_MS });
}
export async function verifyToken(token) {
  const a = await load();
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', a.secret).update(body).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!p.exp || p.exp < Date.now()) return null;
  return { username: p.username, role: p.role };
}

/* -------- Express middleware -------- */
export function authGuard() {
  return async (req, res, next) => {
    if (!(await isEnabled())) return next();
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: 'Nicht authentifiziert' });
    req.user = user;
    next();
  };
}
export function requireAdmin(req, res, next) {
  if (req.user && req.user.role !== 'admin') return res.status(403).json({ error: 'Adminrecht erforderlich' });
  next();
}

// Paths only an admin may mutate (operators are blocked here).
const ADMIN_ONLY_WRITE = [
  /^\/api\/pki(\/|$)/,        // internal CA / certificates
  /^\/api\/endpoints(\/|$)/,  // registering remote Docker roots = full host access
  /^\/api\/settings(\/|$)/,   // global configuration
  /^\/api\/proxy(\/|$)/,      // reverse-proxy stack
];

/**
 * Role-based access control (runs after authGuard, so req.user is set):
 *  - viewer   : read-only (all mutating requests blocked)
 *  - operator : may mutate, except admin-only areas (PKI, endpoints, settings, proxy)
 *  - admin    : unrestricted
 */
export function roleGuard() {
  return (req, res, next) => {
    if (!req.user) return next(); // auth disabled
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
    const role = req.user.role || 'admin';
    if (role === 'admin') return next();
    if (role === 'viewer') return res.status(403).json({ error: 'Nur-Lese-Zugriff (Viewer-Rolle)' });
    // operator
    const path = (req.originalUrl || req.url).split('?')[0];
    if (ADMIN_ONLY_WRITE.some((re) => re.test(path))) {
      return res.status(403).json({ error: 'Diese Aktion ist Administratoren vorbehalten' });
    }
    next();
  };
}
