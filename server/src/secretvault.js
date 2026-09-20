/**
 * Encrypted secret vault — a passphrase-protected store for Docker secret VALUES,
 * kept entirely separate from the central volume/spec backups.
 *
 * WHY THIS EXISTS: Docker Swarm secrets are write-only — `secret inspect` never
 * returns `Spec.Data`. So existing secret values can't be read back from the
 * engine. This vault therefore stores the value the moment the user supplies it
 * (on create, or via explicit entry), encrypted with a user passphrase, so it
 * can later be exported (as one encrypted file) and re-created after a disaster.
 *
 * CRYPTO: AES-256-GCM per entry (random 12-byte IV, 16-byte auth tag); key is
 * derived from the passphrase via scrypt with a per-vault random salt. The
 * passphrase is NEVER stored — without it the vault (and its export) is useless,
 * even to this application. A small "verifier" blob (a known constant encrypted
 * under the same key) lets us validate a passphrase without storing it.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './settings.js';

const VAULT_FILE = path.join(DATA_DIR, 'secret-vault.json');
const MAGIC = 'swarmdash-vault-v1'; // verifier plaintext
const SCRYPT_N = 1 << 15; // 32768 — CPU/memory cost
const KEYLEN = 32; // AES-256

/* ----------------------------- persistence ------------------------- */

async function loadVault() {
  try {
    const raw = await readFile(VAULT_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveVault(vault) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(VAULT_FILE, JSON.stringify(vault, null, 2), 'utf8');
}

/* ------------------------------- crypto ---------------------------- */

function deriveKey(passphrase, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  return crypto.scryptSync(String(passphrase), salt, KEYLEN, { N: SCRYPT_N, maxmem: 128 * 1024 * 1024 });
}

function encrypt(key, plaintextBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') };
}

function decrypt(key, blob) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]);
}

/** Throws a friendly error if the passphrase is wrong (GCM auth failure). */
function verifyPassphrase(vault, passphrase) {
  const key = deriveKey(passphrase, vault.salt);
  try {
    const dec = decrypt(key, vault.verifier).toString('utf8');
    if (dec !== MAGIC) throw new Error('mismatch');
  } catch {
    throw new Error('Falsche Passphrase');
  }
  return key;
}

/* ------------------------------- status ---------------------------- */

/** Public status (never leaks values): initialized?, entry count, names+meta. */
export async function vaultStatus() {
  const vault = await loadVault();
  if (!vault) return { initialized: false, count: 0, entries: [] };
  const entries = Object.entries(vault.entries || {}).map(([name, e]) => ({
    name, labels: e.labels || {}, createdAt: e.createdAt || null, updatedAt: e.updatedAt || null,
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { initialized: true, count: entries.length, entries, createdAt: vault.createdAt || null };
}

/* --------------------------- lifecycle ----------------------------- */

/** Initialize an empty vault with a passphrase (fails if one already exists). */
export async function initVault(passphrase) {
  if (!passphrase || String(passphrase).length < 6) throw new Error('Passphrase zu kurz (min. 6 Zeichen)');
  if (await loadVault()) throw new Error('Tresor existiert bereits');
  const salt = crypto.randomBytes(16).toString('base64');
  const key = deriveKey(passphrase, salt);
  const vault = {
    version: 1, kdf: 'scrypt', salt,
    verifier: encrypt(key, Buffer.from(MAGIC, 'utf8')),
    createdAt: new Date().toISOString(),
    entries: {},
  };
  await saveVault(vault);
  return { ok: true };
}

/** Validate a passphrase against the current vault. */
export async function unlockVault(passphrase) {
  const vault = await loadVault();
  if (!vault) throw new Error('Kein Tresor vorhanden');
  verifyPassphrase(vault, passphrase);
  return { ok: true };
}

/** Change the passphrase: re-derive key + re-encrypt every entry + verifier. */
export async function changePassphrase(oldPass, newPass) {
  const vault = await loadVault();
  if (!vault) throw new Error('Kein Tresor vorhanden');
  const oldKey = verifyPassphrase(vault, oldPass);
  if (!newPass || String(newPass).length < 6) throw new Error('Neue Passphrase zu kurz (min. 6 Zeichen)');
  const salt = crypto.randomBytes(16).toString('base64');
  const newKey = deriveKey(newPass, salt);
  const entries = {};
  for (const [name, e] of Object.entries(vault.entries || {})) {
    const plain = decrypt(oldKey, e);
    entries[name] = { ...encrypt(newKey, plain), labels: e.labels || {}, createdAt: e.createdAt, updatedAt: new Date().toISOString() };
  }
  const next = { ...vault, salt, verifier: encrypt(newKey, Buffer.from(MAGIC, 'utf8')), entries };
  await saveVault(next);
  return { ok: true, count: Object.keys(entries).length };
}

/** Delete the whole vault file. */
export async function destroyVault() {
  await rm(VAULT_FILE, { force: true });
  return { ok: true };
}

/* ----------------------------- entries ----------------------------- */

/** Store (add or overwrite) a secret value in the vault. */
export async function putEntry({ passphrase, name, value, valueB64, labels }) {
  const vault = await loadVault();
  if (!vault) throw new Error('Kein Tresor vorhanden — bitte zuerst initialisieren');
  if (!name || !/^[\w.\-]+$/.test(name)) throw new Error('Ungültiger Secret-Name');
  const key = verifyPassphrase(vault, passphrase);
  const buf = valueB64 != null ? Buffer.from(valueB64, 'base64') : Buffer.from(String(value ?? ''), 'utf8');
  if (buf.length === 0) throw new Error('Leerer Wert');
  const existed = vault.entries[name];
  vault.entries[name] = {
    ...encrypt(key, buf),
    labels: labels || existed?.labels || {},
    createdAt: existed?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveVault(vault);
  return { ok: true, name, overwritten: Boolean(existed) };
}

/** Remove one entry from the vault (does not touch Docker). */
export async function removeEntry(name) {
  const vault = await loadVault();
  if (!vault || !vault.entries[name]) throw new Error('Eintrag nicht gefunden');
  delete vault.entries[name];
  await saveVault(vault);
  return { ok: true };
}

/* --------------------------- export / import ----------------------- */

/** Return the raw encrypted vault JSON for download (still encrypted). */
export async function exportVault() {
  const vault = await loadVault();
  if (!vault) throw new Error('Kein Tresor vorhanden');
  return JSON.stringify(vault, null, 2);
}

/** Import a vault file. mode: 'replace' overwrites; 'merge' needs a matching
 *  passphrase and folds the imported entries into the current vault. */
export async function importVault({ content, mode = 'replace', passphrase }) {
  let incoming;
  try { incoming = typeof content === 'string' ? JSON.parse(content) : content; }
  catch { throw new Error('Ungültige Tresor-Datei (kein JSON)'); }
  if (!incoming?.salt || !incoming?.verifier || typeof incoming.entries !== 'object') {
    throw new Error('Ungültige Tresor-Datei (Struktur)');
  }
  if (mode === 'replace') {
    await saveVault(incoming);
    return { ok: true, mode, count: Object.keys(incoming.entries || {}).length };
  }
  // merge: both vaults must open with the SAME passphrase; re-encrypt imported
  // entries under the current vault's key so everything stays consistent.
  const current = await loadVault();
  if (!current) { await saveVault(incoming); return { ok: true, mode: 'replace', count: Object.keys(incoming.entries || {}).length }; }
  const curKey = verifyPassphrase(current, passphrase);
  let impKey;
  try { impKey = verifyPassphrase(incoming, passphrase); }
  catch { throw new Error('Passphrase passt nicht zur importierten Datei'); }
  let added = 0;
  for (const [name, e] of Object.entries(incoming.entries || {})) {
    const plain = decrypt(impKey, e);
    current.entries[name] = { ...encrypt(curKey, plain), labels: e.labels || {}, createdAt: e.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    added += 1;
  }
  await saveVault(current);
  return { ok: true, mode, count: added };
}

/* --------------------------- recreate in Docker -------------------- */

/**
 * Decrypt selected (or all) entries and (re)create them as Docker secrets.
 * Returns per-secret results. `docker` and `existingNames` are injected by the
 * route so this module stays engine-agnostic and easy to test.
 */
export async function recreateSecrets({ passphrase, names, docker, replaceExisting = false }) {
  const vault = await loadVault();
  if (!vault) throw new Error('Kein Tresor vorhanden');
  const key = verifyPassphrase(vault, passphrase);
  const wanted = (names && names.length) ? names : Object.keys(vault.entries || {});
  const existing = await docker.listSecrets().catch(() => []);
  const byName = new Map(existing.map((s) => [s.Spec?.Name, s.ID]));
  const results = [];
  for (const name of wanted) {
    const e = vault.entries[name];
    if (!e) { results.push({ name, ok: false, error: 'nicht im Tresor' }); continue; }
    try {
      const plain = decrypt(key, e);
      if (byName.has(name)) {
        if (!replaceExisting) { results.push({ name, ok: false, skipped: true, error: 'existiert bereits' }); continue; }
        try { await docker.getSecret(byName.get(name)).remove(); }
        catch (rmErr) { results.push({ name, ok: false, error: `existiert & in Verwendung: ${rmErr.message}` }); continue; }
      }
      const created = await docker.createSecret({ Name: name, Data: plain.toString('base64'), Labels: e.labels || {} });
      results.push({ name, ok: true, id: created.id || created.ID || null });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  return { ok, failed: results.length - ok, total: results.length, results };
}
