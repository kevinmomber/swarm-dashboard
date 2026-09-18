/**
 * Multi-endpoint registry + dockerode client factory.
 *
 * The dashboard historically talked to a single Docker daemon (the `docker`
 * singleton). This module lets the user register ADDITIONAL endpoints —
 * standalone Docker hosts or further Swarm managers — and obtain a dockerode
 * client for any of them on demand.
 *
 * The built-in "local" endpoint is always present and maps to the existing
 * singleton (the daemon the dashboard container itself is attached to).
 *
 * Connections:
 *  - local : the mounted socket / DOCKER_HOST of the dashboard container
 *  - tcp   : tcp(s)://host:port, optionally with TLS client certs (recommended)
 *  - ssh   : ssh://user@host (best-effort; needs a usable key/agent)
 *
 * Secrets (TLS key/cert/ca, ssh password) are stored server-side only and never
 * returned by the redacted read API.
 */
import Docker from 'dockerode';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './settings.js';
import { docker as localDocker } from './docker.js';

const FILE = path.join(DATA_DIR, 'endpoints.json');
const NAME_RE = /^[\w][\w .-]{0,48}$/;

let cache = null;                 // stored endpoint definitions (excludes local)
const clientCache = new Map();    // id -> { sig, client }

async function load() {
  if (cache) return cache;
  try { cache = JSON.parse(await readFile(FILE, 'utf8')); }
  catch { cache = []; }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

async function persist() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(cache, null, 2), 'utf8');
}

/** Connection signature — changing it invalidates a cached client. */
function sigOf(def) {
  return JSON.stringify({ k: def.conn?.kind, h: def.conn?.host, p: def.conn?.port, t: Boolean(def.conn?.tls?.cert) });
}

/** Build a dockerode client for a stored endpoint definition. */
function buildClient(def) {
  const c = def.conn || {};
  if (c.kind === 'tcp') {
    if (!c.host) throw new Error('host erforderlich');
    const tls = c.tls || {};
    const useTls = Boolean(tls.ca || tls.cert || tls.key || c.port === 2376);
    const opts = { host: c.host, port: Number(c.port) || (useTls ? 2376 : 2375), protocol: useTls ? 'https' : 'http' };
    if (useTls) {
      if (tls.ca) opts.ca = tls.ca;
      if (tls.cert) opts.cert = tls.cert;
      if (tls.key) opts.key = tls.key;
    }
    return new Docker(opts);
  }
  if (c.kind === 'ssh') {
    if (!c.host) throw new Error('host erforderlich');
    const opts = {
      protocol: 'ssh',
      host: c.host,
      port: Number(c.port) || 22,
      username: c.username || 'root',
      sshOptions: {},
    };
    if (c.password) opts.sshOptions.password = c.password;
    if (c.privateKey) opts.sshOptions.privateKey = c.privateKey;
    return new Docker(opts);
  }
  throw new Error(`Unbekannter Verbindungstyp: ${c.kind}`);
}

/** Return a dockerode client for the given endpoint id (local when omitted). */
export async function getDocker(endpointId) {
  if (!endpointId || endpointId === 'local') return localDocker;
  const list = await load();
  const def = list.find((e) => e.id === endpointId);
  if (!def) throw Object.assign(new Error('Endpoint nicht gefunden'), { status: 404 });
  const sig = sigOf(def);
  const hit = clientCache.get(def.id);
  if (hit && hit.sig === sig) return hit.client;
  const client = buildClient(def);
  clientCache.set(def.id, { sig, client });
  return client;
}

/** True when the endpoint id refers to a read-only endpoint (blocks writes). */
export async function isReadOnly(endpointId) {
  if (!endpointId || endpointId === 'local') return false;
  const list = await load();
  const def = list.find((e) => e.id === endpointId);
  return Boolean(def?.readOnly);
}

/** Synthetic definition for the always-present local endpoint. */
async function localDef() {
  const local = await getLocalMeta();
  return {
    id: 'local',
    name: local.name || 'Lokal',
    conn: { kind: 'local' },
    tags: (await load()).find?.((e) => e.id === '__local_tags__')?.tags || localTags,
    readOnly: false,
    builtin: true,
    type: local.type,
  };
}

let localTags = [];
async function getLocalMeta() {
  try {
    const info = await localDocker.info();
    return { name: info.Name, type: info.Swarm?.ControlAvailable ? 'swarm' : (info.Swarm?.LocalNodeState === 'active' ? 'swarm-worker' : 'standalone') };
  } catch { return { name: 'Lokal', type: 'unknown' }; }
}

/** Redacted public view of a definition (no secrets). */
function redactDef(def) {
  const tls = def.conn?.tls || {};
  return {
    id: def.id,
    name: def.name,
    builtin: Boolean(def.builtin),
    type: def.type || null,
    tags: def.tags || [],
    readOnly: Boolean(def.readOnly),
    conn: {
      kind: def.conn?.kind,
      host: def.conn?.host || null,
      port: def.conn?.port || null,
      username: def.conn?.username || null,
      hasTls: Boolean(tls.ca || tls.cert || tls.key),
      hasPassword: Boolean(def.conn?.password),
      hasPrivateKey: Boolean(def.conn?.privateKey),
    },
  };
}

/** All endpoints (local first), redacted. */
export async function listEndpoints() {
  const list = await load();
  const stored = list.filter((e) => e.id !== '__local_tags__').map(redactDef);
  const ld = await localDef();
  return [redactDef(ld), ...stored];
}

/** Probe an endpoint; returns reachability + basic identity. */
export async function testEndpoint(idOrDef) {
  let client, def;
  if (typeof idOrDef === 'string') { client = await getDocker(idOrDef); }
  else { def = idOrDef; client = def.conn?.kind === 'local' ? localDocker : buildClient(def); }
  try {
    const [ver, info] = await Promise.all([client.version(), client.info()]);
    const swarm = info.Swarm?.ControlAvailable === true ? 'manager'
      : info.Swarm?.LocalNodeState === 'active' ? 'worker' : 'none';
    return {
      ok: true,
      version: ver.Version,
      apiVersion: ver.ApiVersion,
      os: `${info.OperatingSystem || ''} (${info.OSType}/${info.Architecture})`,
      hostname: info.Name,
      type: swarm === 'manager' ? 'swarm' : swarm === 'worker' ? 'swarm-worker' : 'standalone',
      nodes: info.Swarm?.Nodes ?? null,
      containers: info.Containers ?? null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function newId() { return crypto.randomBytes(6).toString('hex'); }

export async function addEndpoint(input) {
  const list = await load();
  const name = String(input?.name || '').trim();
  if (!NAME_RE.test(name)) throw new Error('Ungültiger Name');
  const kind = input?.conn?.kind;
  if (!['tcp', 'ssh'].includes(kind)) throw new Error('conn.kind muss tcp oder ssh sein');
  if (input?.conn?.kind === 'tcp' && input?.conn?.port === 2375 && !input?.allowInsecure) {
    // 2375 = unauthenticated Docker API. Refuse unless explicitly acknowledged.
    if (!(input?.conn?.tls?.cert)) throw new Error('Unverschlüsselter Port 2375 ist nicht erlaubt (TLS-Zertifikate angeben oder allowInsecure setzen)');
  }
  const def = {
    id: newId(),
    name,
    tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    readOnly: Boolean(input.readOnly),
    conn: {
      kind,
      host: String(input.conn.host || '').trim(),
      port: Number(input.conn.port) || (kind === 'ssh' ? 22 : 2376),
      username: input.conn.username ? String(input.conn.username).trim() : undefined,
      password: input.conn.password || undefined,
      privateKey: input.conn.privateKey || undefined,
      tls: input.conn.tls && (input.conn.tls.ca || input.conn.tls.cert || input.conn.tls.key)
        ? { ca: input.conn.tls.ca || undefined, cert: input.conn.tls.cert || undefined, key: input.conn.tls.key || undefined }
        : undefined,
    },
  };
  list.push(def);
  cache = list;
  await persist();
  return redactDef(def);
}

export async function updateEndpoint(id, patch) {
  if (id === 'local') {
    // Only tags are editable on the built-in local endpoint.
    localTags = Array.isArray(patch?.tags) ? patch.tags.map((t) => String(t).trim()).filter(Boolean) : localTags;
    const list = await load();
    let row = list.find((e) => e.id === '__local_tags__');
    if (!row) { row = { id: '__local_tags__', tags: [] }; list.push(row); }
    row.tags = localTags;
    cache = list; await persist();
    return redactDef(await localDef());
  }
  const list = await load();
  const def = list.find((e) => e.id === id);
  if (!def) throw Object.assign(new Error('Endpoint nicht gefunden'), { status: 404 });
  if (patch.name !== undefined) { if (!NAME_RE.test(String(patch.name).trim())) throw new Error('Ungültiger Name'); def.name = String(patch.name).trim(); }
  if (patch.tags !== undefined) def.tags = (patch.tags || []).map((t) => String(t).trim()).filter(Boolean);
  if (patch.readOnly !== undefined) def.readOnly = Boolean(patch.readOnly);
  if (patch.conn) {
    def.conn = def.conn || {};
    const c = patch.conn;
    if (c.host !== undefined) def.conn.host = String(c.host).trim();
    if (c.port !== undefined) def.conn.port = Number(c.port) || def.conn.port;
    if (c.username !== undefined) def.conn.username = c.username ? String(c.username).trim() : undefined;
    // Secrets: only overwrite when a non-empty value is supplied.
    if (c.password) def.conn.password = c.password;
    if (c.privateKey) def.conn.privateKey = c.privateKey;
    if (c.tls) {
      def.conn.tls = def.conn.tls || {};
      if (c.tls.ca) def.conn.tls.ca = c.tls.ca;
      if (c.tls.cert) def.conn.tls.cert = c.tls.cert;
      if (c.tls.key) def.conn.tls.key = c.tls.key;
    }
  }
  clientCache.delete(id);
  cache = list; await persist();
  return redactDef(def);
}

export async function deleteEndpoint(id) {
  if (id === 'local') throw new Error('Der lokale Endpoint kann nicht entfernt werden');
  const list = await load();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) throw Object.assign(new Error('Endpoint nicht gefunden'), { status: 404 });
  list.splice(i, 1);
  clientCache.delete(id);
  cache = list; await persist();
  return { ok: true };
}

/**
 * Aggregated, read-only node/host inventory across ALL endpoints. Each endpoint
 * is probed independently; a failure on one never blocks the others.
 */
export async function inventory() {
  const eps = await listEndpoints();
  const out = await Promise.all(eps.map(async (ep) => {
    try {
      const client = await getDocker(ep.id);
      const info = await client.info();
      const isSwarm = info.Swarm?.LocalNodeState === 'active';
      const base = {
        id: ep.id, name: ep.name, tags: ep.tags, readOnly: ep.readOnly, builtin: ep.builtin,
        reachable: true,
        dockerVersion: info.ServerVersion,
        type: info.Swarm?.ControlAvailable ? 'swarm' : isSwarm ? 'swarm-worker' : 'standalone',
        containers: info.Containers ?? null,
        containersRunning: info.ContainersRunning ?? null,
        images: info.Images ?? null,
        ncpu: info.NCPU ?? null,
        memTotal: info.MemTotal ?? null,
      };
      if (info.Swarm?.ControlAvailable) {
        // Manager: enumerate real swarm nodes.
        const nodes = await client.listNodes();
        base.nodes = nodes.map((n) => ({
          id: n.ID,
          hostname: n.Description?.Hostname,
          role: n.Spec?.Role,
          availability: n.Spec?.Availability,
          state: n.Status?.State,
          leader: n.ManagerStatus?.Leader ?? false,
          addr: n.Status?.Addr,
          engine: n.Description?.Engine?.EngineVersion,
        }));
      } else {
        // Standalone (or non-manager): a single synthetic host node.
        base.nodes = [{
          id: info.ID || ep.id,
          hostname: info.Name,
          role: 'standalone',
          availability: 'active',
          state: 'ready',
          leader: false,
          addr: ep.conn?.host || null,
          engine: info.ServerVersion,
          containers: info.Containers,
          containersRunning: info.ContainersRunning,
          images: info.Images,
          ncpu: info.NCPU,
          memTotal: info.MemTotal,
        }];
      }
      return base;
    } catch (e) {
      return { id: ep.id, name: ep.name, tags: ep.tags, readOnly: ep.readOnly, builtin: ep.builtin, reachable: false, error: e.message, nodes: [] };
    }
  }));
  return out;
}
