import { Router } from 'express';
import {
  authStatus, setEnabled, listUsers, createUser, deleteUser, changePassword,
  verifyLogin, issueToken, verifyToken, isEnabled,
} from '../auth.js';

const router = Router();

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};

/** During setup (auth disabled) admin endpoints are open; once enabled require an admin token. */
async function guardAdmin(req, res, next) {
  if (!(await isEnabled())) return next();
  const user = await verifyToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Nicht authentifiziert' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Adminrecht erforderlich' });
  req.user = user;
  next();
}
async function requireToken(req, res, next) {
  const user = await verifyToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Nicht authentifiziert' });
  req.user = user;
  next();
}

router.get('/status', async (req, res, next) => {
  try { res.json(await authStatus()); } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const user = await verifyLogin(username, password);
    if (!user) return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
    res.json({ token: await issueToken(user), user });
  } catch (err) { next(err); }
});

router.get('/me', async (req, res, next) => {
  try {
    if (!(await isEnabled())) return res.json({ enabled: false, user: null });
    const user = await verifyToken(bearer(req));
    if (!user) return res.status(401).json({ error: 'Nicht authentifiziert' });
    res.json({ enabled: true, user });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => res.json({ ok: true }));

router.get('/users', guardAdmin, async (req, res, next) => {
  try { res.json(await listUsers()); } catch (err) { next(err); }
});
router.post('/users', guardAdmin, async (req, res, next) => {
  try {
    const { username, password, role } = req.body || {};
    res.json(await createUser(username, password, role === 'viewer' ? 'viewer' : 'admin'));
  } catch (err) { next(err); }
});
router.delete('/users/:username', guardAdmin, async (req, res, next) => {
  try { await deleteUser(req.params.username); res.json({ ok: true }); } catch (err) { next(err); }
});

router.post('/password', requireToken, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const target = username && req.user.role === 'admin' ? username : req.user.username;
    await changePassword(target, password);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/enable', guardAdmin, async (req, res, next) => {
  try { res.json(await setEnabled(Boolean(req.body?.enabled))); } catch (err) { next(err); }
});

export default router;
