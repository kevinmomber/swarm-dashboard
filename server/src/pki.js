/**
 * Internal PKI — SQLite-backed store (single source of truth).
 *
 * A self-signed Root CA plus on-demand leaf/server certificates, fully managed
 * from the dashboard. Keys are generated with Node's native crypto (fast) and
 * X.509 assembly / PKCS#12 bundling / CRL signing are done with node-forge.
 *
 * All state lives in a single SQLite database under DATA_DIR/pki/pki.db
 * (mounted volume swarmdash_data): the CA (cert + key PEM), every issued leaf
 * (cert + key PEM + metadata), and counters (next serial, CRL number). Storing
 * everything in one transactional database makes operations atomic — e.g. a
 * reset removes the CA and all certificates in a single commit, so the
 * "CA gone but certificates still present" inconsistency cannot occur.
 *
 * On first use, a legacy file layout (index.json + ca-cert.pem + certs/*.pem)
 * is imported automatically and then archived.
 *
 * Certificates are materialized to PEM files only transiently by the reverse
 * proxy wiring (see proxy.js buildPkiProxyPlan), never as the primary store.
 */
import forge from 'node-forge';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync,
} from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './settings.js';

const PKI_DIR = path.join(DATA_DIR, 'pki');
const DB_FILE = path.join(PKI_DIR, 'pki.db');

// Legacy (pre-SQLite) file layout — read once for migration, then archived.
const CERTS_DIR = path.join(PKI_DIR, 'certs');
const CA_CERT = path.join(PKI_DIR, 'ca-cert.pem');
const CA_KEY = path.join(PKI_DIR, 'ca-key.pem');
const INDEX = path.join(PKI_DIR, 'index.json');
const CRL_FILE = path.join(PKI_DIR, 'crl.pem');
const legacyCertPath = (id) => path.join(CERTS_DIR, `${id}.crt.pem`);
const legacyKeyPath = (id) => path.join(CERTS_DIR, `${id}.key.pem`);

/* ------------------------------------------------------------------ */
/* helpers (crypto)                                                   */
/* ------------------------------------------------------------------ */

const ALLOWED_BITS = [2048, 3072, 4096];
const clampBits = (b) => (ALLOWED_BITS.includes(Number(b)) ? Number(b) : 2048);
const clampDays = (d, max = 7300) => {
  const n = Math.floor(Number(d));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, max);
};
const isIpv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const safeName = (s) => (s || 'cert').replace(/[^a-zA-Z0-9._-]/g, '_');

function normalizeSans(sans, cn) {
  const raw = Array.isArray(sans) ? sans : String(sans || '').split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  const add = (v) => {
    const t = String(v || '').trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  if (cn) add(cn);
  for (const s of raw) add(s);
  return out;
}

function fingerprint(cert) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md.digest().toHex().toUpperCase().match(/.{2}/g).join(':');
}

function genForgeKeys(bits) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return {
    privateKey: forge.pki.privateKeyFromPem(privateKey),
    publicKey: forge.pki.publicKeyFromPem(publicKey),
  };
}

/* ------------------------------------------------------------------ */
/* storage (SQLite)                                                   */
/* ------------------------------------------------------------------ */

let db = null;

function getDb() {
  if (db) return db;
  mkdirSync(PKI_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ca (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cn TEXT, org TEXT, created_at TEXT, not_before TEXT, not_after TEXT,
      serial_hex TEXT, bits INTEGER, cert_pem TEXT, key_pem TEXT
    );
    CREATE TABLE IF NOT EXISTS certs (
      id TEXT PRIMARY KEY, serial_hex TEXT, cn TEXT, sans TEXT,
      created_at TEXT, not_before TEXT, not_after TEXT, bits INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0, revoked_at TEXT, reason TEXT,
      cert_pem TEXT, key_pem TEXT
    );
    CREATE TABLE IF NOT EXISTS meta ( k TEXT PRIMARY KEY, v TEXT );
  `);
  migrateLegacy();
  return db;
}

function metaGet(k, def = null) {
  const row = getDb().prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return row ? row.v : def;
}
function metaSet(k, v) {
  getDb().prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(k, String(v));
}

function caRow() {
  return getDb().prepare('SELECT * FROM ca WHERE id = 1').get() || null;
}

function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/** Import a legacy index.json + PEM file layout into the DB (one-time). */
function migrateLegacy() {
  const already = db.prepare('SELECT COUNT(*) AS c FROM ca').get().c;
  if (already) return;
  if (!existsSync(INDEX) || !existsSync(CA_CERT) || !existsSync(CA_KEY)) return;
  try {
    const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
    const caPem = readFileSync(CA_CERT, 'utf8');
    const caKeyPem = readFileSync(CA_KEY, 'utf8');
    const m = idx.ca || {};
    db.exec('BEGIN');
    db.prepare(`INSERT INTO ca(id, cn, org, created_at, not_before, not_after, serial_hex, bits, cert_pem, key_pem)
      VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.cn || '', m.org || '', m.createdAt || null, m.notBefore || null, m.notAfter || null,
        m.serialHex || '01', m.bits || null, caPem, caKeyPem);
    const ins = db.prepare(`INSERT INTO certs(id, serial_hex, cn, sans, created_at, not_before, not_after, bits, revoked, revoked_at, reason, cert_pem, key_pem)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of idx.certs || []) {
      let certPem = ''; let keyPem = '';
      try { certPem = readFileSync(legacyCertPath(c.id), 'utf8'); keyPem = readFileSync(legacyKeyPath(c.id), 'utf8'); } catch { /* missing */ }
      ins.run(c.id, c.serialHex, c.cn, JSON.stringify(c.sans || []), c.createdAt || null,
        c.notBefore || null, c.notAfter || null, c.bits || null,
        c.revoked ? 1 : 0, c.revokedAt || null, c.reason || null, certPem, keyPem);
    }
    db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run('next_serial', String(idx.nextSerial || 2));
    db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run('crl_number', String(idx.crlNumber || 0));
    db.exec('COMMIT');
    // Archive the legacy layout so it is neither re-imported nor read again.
    try { renameSync(INDEX, `${INDEX}.migrated`); } catch { /* ignore */ }
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    // On failure leave legacy files intact; the DB simply reports "no CA".
  }
}

/** Remove any legacy file artifacts (used on reset for a fully clean slate). */
function removeLegacyArtifacts() {
  for (const p of [CA_CERT, CA_KEY, CRL_FILE, INDEX, `${INDEX}.migrated`, CERTS_DIR]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function rowToMeta(r) {
  return {
    id: r.id,
    cn: r.cn,
    sans: JSON.parse(r.sans || '[]'),
    serialHex: r.serial_hex,
    createdAt: r.created_at,
    notBefore: r.not_before,
    notAfter: r.not_after,
    bits: r.bits,
    revoked: !!r.revoked,
    revokedAt: r.revoked_at,
    reason: r.reason,
  };
}

const statusOf = (c) => {
  if (c.revoked) return 'revoked';
  return Date.now() > new Date(c.notAfter).getTime() ? 'expired' : 'valid';
};

/** Load the CA as forge objects, or throw if none exists. */
function loadCa() {
  const row = caRow();
  if (!row) throw new Error('Keine CA vorhanden. Bitte zuerst eine Root-CA anlegen.');
  return {
    cert: forge.pki.certificateFromPem(row.cert_pem),
    key: forge.pki.privateKeyFromPem(row.key_pem),
    row,
  };
}

/* ------------------------------------------------------------------ */
/* CA                                                                 */
/* ------------------------------------------------------------------ */

export async function getCaStatus() {
  const row = caRow();
  if (!row) return { exists: false };
  const cert = forge.pki.certificateFromPem(row.cert_pem);
  const certCount = getDb().prepare('SELECT COUNT(*) AS c FROM certs').get().c;
  return {
    exists: true,
    cn: row.cn || (cert.subject.getField('CN') ? cert.subject.getField('CN').value : ''),
    org: row.org || '',
    createdAt: row.created_at || null,
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
    serial: cert.serialNumber,
    bits: row.bits || null,
    fingerprint: fingerprint(cert),
    certCount,
  };
}

export async function createCa({ cn, org, days, bits } = {}) {
  if (caRow()) {
    throw new Error('Es existiert bereits eine CA. Bitte zuerst die PKI zurücksetzen.');
  }
  const name = String(cn || '').trim();
  if (!name) throw new Error('Common Name (CN) erforderlich');
  const b = clampBits(bits);
  const d = clampDays(days || 3650);

  const keys = genForgeKeys(b);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + d);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs = [{ name: 'commonName', value: name }];
  if (org && String(org).trim()) attrs.push({ name: 'organizationName', value: String(org).trim() });
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  tx((d2) => {
    d2.prepare(`INSERT INTO ca(id, cn, org, created_at, not_before, not_after, serial_hex, bits, cert_pem, key_pem)
      VALUES(1, ?, ?, ?, ?, ?, '01', ?, ?, ?)`)
      .run(name, org ? String(org).trim() : '', new Date().toISOString(),
        notBefore.toISOString(), notAfter.toISOString(), b,
        forge.pki.certificateToPem(cert), forge.pki.privateKeyToPem(keys.privateKey));
    d2.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('next_serial', '2');
    d2.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('crl_number', '0');
  });
  return getCaStatus();
}

export async function getCaCertPem() {
  const row = caRow();
  if (!row) throw new Error('Keine CA vorhanden.');
  return row.cert_pem;
}

/** Wipe the entire PKI (CA + all issued certificates) in one atomic commit. */
export async function resetPki() {
  tx((d) => {
    d.exec('DELETE FROM certs');
    d.exec('DELETE FROM ca');
    d.exec('DELETE FROM meta');
  });
  removeLegacyArtifacts();
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Leaf certificates                                                  */
/* ------------------------------------------------------------------ */

export async function issueCert({ cn, sans, days, bits } = {}) {
  const ca = loadCa();
  const name = String(cn || '').trim();
  if (!name) throw new Error('Common Name (CN) erforderlich');
  const b = clampBits(bits);
  const d = clampDays(days || 825);
  const cleanSans = normalizeSans(sans, name);

  const serial = Number(metaGet('next_serial', '2')) || 2;
  const serialHex = serial.toString(16).padStart(2, '0');

  const keys = genForgeKeys(b);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serialHex;
  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + d);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  cert.setSubject([{ name: 'commonName', value: name }]);
  cert.setIssuer(ca.cert.subject.attributes);
  const altNames = cleanSans.map((s) => (isIpv4(s) ? { type: 7, ip: s } : { type: 2, value: s }));
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  const id = crypto.randomUUID();
  tx((d2) => {
    d2.prepare(`INSERT INTO certs(id, serial_hex, cn, sans, created_at, not_before, not_after, bits, revoked, cert_pem, key_pem)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(id, serialHex, name, JSON.stringify(cleanSans), notBefore.toISOString(),
        notBefore.toISOString(), notAfter.toISOString(), b,
        forge.pki.certificateToPem(cert), forge.pki.privateKeyToPem(keys.privateKey));
    d2.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run('next_serial', String(serial + 1));
  });
  return { id, cn: name, sans: cleanSans, serialHex };
}

export async function listCerts() {
  const rows = getDb().prepare('SELECT id, serial_hex, cn, sans, created_at, not_before, not_after, bits, revoked, revoked_at, reason FROM certs ORDER BY serial_hex').all();
  return rows.map((r) => {
    const meta = rowToMeta(r);
    return { ...meta, status: statusOf(meta) };
  });
}

function certRow(id) {
  const row = getDb().prepare('SELECT * FROM certs WHERE id = ?').get(id);
  if (!row) throw new Error('Zertifikat nicht gefunden');
  return row;
}

/** Full material for a cert: meta + PEMs (cert, key, ca, fullchain). */
export async function getCert(id) {
  const row = certRow(id);
  const ca = caRow();
  if (!ca) throw new Error('Keine CA vorhanden.');
  const meta = rowToMeta(row);
  const certPem = row.cert_pem;
  const keyPem = row.key_pem;
  const caPem = ca.cert_pem;
  return {
    meta: { ...meta, status: statusOf(meta) },
    certPem,
    keyPem,
    caPem,
    fullchainPem: `${certPem.trim()}\n${caPem.trim()}\n`,
  };
}

/** Return { filename, body } for a download format. */
export async function certDownload(id, fmt = 'cert') {
  const { meta, certPem, keyPem, caPem, fullchainPem } = await getCert(id);
  const base = safeName(meta.cn);
  switch (fmt) {
    case 'key':
      return { filename: `${base}.key.pem`, body: keyPem };
    case 'chain':
      return { filename: `${base}.chain.pem`, body: `${caPem.trim()}\n` };
    case 'fullchain':
      return { filename: `${base}.fullchain.pem`, body: fullchainPem };
    case 'cert':
    default:
      return { filename: `${base}.crt.pem`, body: certPem };
  }
}

/** Build a PKCS#12 (.p12) bundle: leaf key + cert + CA chain, base64-encoded. */
export async function bundlePkcs12(id, passphrase = '') {
  const { meta, certPem, keyPem, caPem } = await getCert(id);
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem);
  const ca = forge.pki.certificateFromPem(caPem);
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert, ca], String(passphrase || ''), {
    algorithm: '3des',
    friendlyName: meta.cn,
  });
  const der = forge.asn1.toDer(asn1).getBytes();
  return { filename: `${safeName(meta.cn)}.p12`, dataB64: forge.util.encode64(der) };
}

export async function deleteCert(id) {
  const info = getDb().prepare('DELETE FROM certs WHERE id = ?').run(id);
  if (!info.changes) throw new Error('Zertifikat nicht gefunden');
  return { ok: true };
}

/**
 * Export the CA and every non-revoked leaf (cert + key PEM) for wiring into a
 * reverse proxy. Returns { ca, certs: [{ serialHex, cn, certPem, keyPem }] }.
 */
export async function exportForTraefik() {
  const ca = caRow();
  if (!ca) return { ca: null, certs: [] };
  const rows = getDb().prepare('SELECT serial_hex, cn, cert_pem, key_pem FROM certs WHERE revoked = 0 ORDER BY serial_hex').all();
  return {
    ca: ca.cert_pem,
    certs: rows.map((r) => ({ serialHex: r.serial_hex, cn: r.cn, certPem: r.cert_pem, keyPem: r.key_pem })),
  };
}

/* ------------------------------------------------------------------ */
/* Revocation + CRL                                                   */
/* ------------------------------------------------------------------ */

const CRL_DAYS = 30;
const REASON_CODES = {
  unspecified: 0,
  keyCompromise: 1,
  caCompromise: 2,
  affiliationChanged: 3,
  superseded: 4,
  cessationOfOperation: 5,
  certificateHold: 6,
};

const A = forge.asn1;
const U = A.Class.UNIVERSAL;
const CTX = A.Class.CONTEXT_SPECIFIC;
const T = A.Type;

function serialBytes(hex) {
  let bytes = forge.util.hexToBytes(hex.length % 2 ? `0${hex}` : hex);
  if (bytes.length && bytes.charCodeAt(0) & 0x80) bytes = `\x00${bytes}`;
  return bytes;
}

function caIssuerName(caCert) {
  const certAsn1 = forge.pki.certificateToAsn1(caCert);
  const fields = certAsn1.value[0].value;
  const hasVersion = fields[0].tagClass === CTX && fields[0].type === 0;
  return fields[hasVersion ? 5 : 4]; // subject Name
}

function sigAlgSha256Rsa() {
  return A.create(U, T.SEQUENCE, true, [
    A.create(U, T.OID, false, A.oidToDer('1.2.840.113549.1.1.11').getBytes()),
    A.create(U, T.NULL, false, ''),
  ]);
}

/** Build a signed X.509 v2 CRL (PEM) from the CA and the revoked list. */
function buildCrlPem(caCert, caKey, revoked, number) {
  const thisUpdate = new Date();
  const nextUpdate = new Date(thisUpdate.getTime() + CRL_DAYS * 86400000);

  const revokedEntries = revoked.map((r) => {
    const entry = [
      A.create(U, T.INTEGER, false, serialBytes(r.serialHex)),
      A.create(U, T.UTCTIME, false, A.dateToUtcTime(new Date(r.revokedAt))),
    ];
    const code = REASON_CODES[r.reason];
    if (code) {
      const reasonExt = A.create(U, T.SEQUENCE, true, [
        A.create(U, T.OID, false, A.oidToDer('2.5.29.21').getBytes()),
        A.create(U, T.OCTETSTRING, false, A.toDer(
          A.create(U, T.ENUMERATED, false, A.integerToDer(code).getBytes()),
        ).getBytes()),
      ]);
      entry.push(A.create(U, T.SEQUENCE, true, [reasonExt]));
    }
    return A.create(U, T.SEQUENCE, true, entry);
  });

  const crlNumberExt = A.create(U, T.SEQUENCE, true, [
    A.create(U, T.OID, false, A.oidToDer('2.5.29.20').getBytes()),
    A.create(U, T.OCTETSTRING, false, A.toDer(
      A.create(U, T.INTEGER, false, A.integerToDer(number).getBytes()),
    ).getBytes()),
  ]);

  const tbsChildren = [
    A.create(U, T.INTEGER, false, A.integerToDer(1).getBytes()), // version v2
    sigAlgSha256Rsa(),
    caIssuerName(caCert),
    A.create(U, T.UTCTIME, false, A.dateToUtcTime(thisUpdate)),
    A.create(U, T.UTCTIME, false, A.dateToUtcTime(nextUpdate)),
  ];
  if (revokedEntries.length) tbsChildren.push(A.create(U, T.SEQUENCE, true, revokedEntries));
  tbsChildren.push(A.create(CTX, 0, true, [A.create(U, T.SEQUENCE, true, [crlNumberExt])]));

  const tbs = A.create(U, T.SEQUENCE, true, tbsChildren);
  const tbsDer = A.toDer(tbs).getBytes();
  const md = forge.md.sha256.create();
  md.update(tbsDer);
  const signature = caKey.sign(md);

  const crl = A.create(U, T.SEQUENCE, true, [
    tbs,
    sigAlgSha256Rsa(),
    A.create(U, T.BITSTRING, false, `\x00${signature}`),
  ]);
  const der = A.toDer(crl).getBytes();
  const b64 = forge.util.encode64(der).match(/.{1,64}/g).join('\n');
  return `-----BEGIN X509 CRL-----\n${b64}\n-----END X509 CRL-----\n`;
}

function revokedList() {
  return getDb().prepare('SELECT serial_hex, cn, revoked_at, reason FROM certs WHERE revoked = 1 ORDER BY serial_hex')
    .all()
    .map((r) => ({ serialHex: r.serial_hex, cn: r.cn, revokedAt: r.revoked_at, reason: r.reason }));
}

export async function revokeCert(id, reason = 'unspecified') {
  const row = getDb().prepare('SELECT revoked FROM certs WHERE id = ?').get(id);
  if (!row) throw new Error('Zertifikat nicht gefunden');
  if (row.revoked) throw new Error('Zertifikat ist bereits gesperrt');
  const reasonKey = REASON_CODES[reason] != null ? reason : 'unspecified';
  const revokedAt = new Date().toISOString();
  tx((d) => {
    d.prepare('UPDATE certs SET revoked = 1, revoked_at = ?, reason = ? WHERE id = ?').run(revokedAt, reasonKey, id);
    const n = Number(metaGet('crl_number', '0')) + 1;
    d.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('crl_number', String(n));
  });
  return { ok: true, revokedAt, reason: reasonKey };
}

/** Return the current CRL as PEM (regenerated fresh so dates stay valid). */
export async function getCrlPem() {
  const ca = loadCa();
  const number = Number(metaGet('crl_number', '1')) || 1;
  return buildCrlPem(ca.cert, ca.key, revokedList(), number);
}

export async function crlStatus() {
  if (!caRow()) return { exists: false };
  const revoked = revokedList();
  const now = new Date();
  return {
    exists: true,
    number: Number(metaGet('crl_number', '0')) || 0,
    revokedCount: revoked.length,
    thisUpdate: now.toISOString(),
    nextUpdate: new Date(now.getTime() + CRL_DAYS * 86400000).toISOString(),
    revoked,
  };
}
