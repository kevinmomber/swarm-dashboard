/**
 * Swarm Dashboard — Node Agent
 *
 * Deployed as a GLOBAL swarm service (one per node) from the same image as the
 * dashboard. Two jobs:
 *
 *  1. Report the real host CPU/RAM/disk of its node (GET /metrics).
 *  2. Broker container operations that Swarm does NOT proxy through the manager —
 *     interactive console (WS /exec) and image export (GET /export) — against the
 *     LOCAL Docker engine, so the dashboard can reach containers on remote nodes.
 *
 * Requires:
 *   - host root mounted read-only (default /host) for metrics
 *   - the local Docker socket for /exec and /export
 * Node identity is injected via templated env (NODE_ID / NODE_HOSTNAME).
 *
 * The agent only ever operates on containers by ID on its own engine; it never
 * calls swarm-manager APIs.
 */
import http from 'node:http';
import os from 'node:os';
import { readFile, statfs, stat, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Docker from 'dockerode';
import { WebSocketServer } from 'ws';
import { exportVolume, importVolume, volumeSize, migrationDiskProbe, volumeCopyLocal } from './volarchive.js';
import { containerState, recreateWithVolume, containerConfig, recreateContainer, containerTop, containerStatsBatch, imageHistory, fsList, fsRead, fsOp, volumeFsList, volumeFsRead, volumeFsOp } from './containerops.js';
import { scanImageLocal } from './security.js';
import { listInterfaces, createConfigNetwork, getConfigNetwork, removeConfigNetwork, containerNetworks } from './netlocal.js';

const PORT = Number(process.env.AGENT_PORT) || 9787;
const HOST_ROOT = process.env.HOST_ROOT || '/host';
const NODE_ID = process.env.NODE_ID || '';
const NODE_HOSTNAME = process.env.NODE_HOSTNAME || os.hostname();
const docker = new Docker({ socketPath: process.env.DOCKER_SOCK || '/var/run/docker.sock' });

const AGENT_VERSION = (() => {
  try { return createRequire(import.meta.url)('../package.json').version || null; } catch { return null; }
})();

/* ----------------------------- metrics ----------------------------- */

async function readMem() {
  try {
    const mi = await readFile(`${HOST_ROOT}/proc/meminfo`, 'utf8');
    const kb = (k) => (Number(mi.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1]) || 0) * 1024;
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    return { total, used: total ? total - available : 0, free: available };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}
async function readLoad() {
  try {
    return parseFloat((await readFile(`${HOST_ROOT}/proc/loadavg`, 'utf8')).split(/\s+/)[0]) || 0;
  } catch {
    return 0;
  }
}
async function readDisk() {
  try {
    const s = await statfs(HOST_ROOT);
    return { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}
async function collect() {
  const [mem, load1, disk] = await Promise.all([readMem(), readLoad(), readDisk()]);
  const cpus = os.cpus()?.length || 0;
  return {
    nodeId: NODE_ID,
    hostname: NODE_HOSTNAME,
    version: AGENT_VERSION,
    at: new Date().toISOString(),
    cpu: { load1, cpus, loadPct: cpus ? Math.min(100, Math.round((load1 / cpus) * 100)) : null },
    mem,
    disk,
  };
}

/* --------------------------- host audit ---------------------------- */

/** Stat a host path (via HOST_ROOT); returns perms/owner or {exists:false}. */
async function hostStat(rel) {
  try {
    const s = await stat(`${HOST_ROOT}${rel}`);
    return { path: rel, exists: true, mode: s.mode & 0o777, uid: s.uid, gid: s.gid, isDir: s.isDirectory() };
  } catch {
    return { path: rel, exists: false };
  }
}

/** Read + parse /etc/docker/daemon.json from the host (or null). */
async function hostDaemonJson() {
  try { return JSON.parse(await readFile(`${HOST_ROOT}/etc/docker/daemon.json`, 'utf8')); }
  catch { return null; }
}

/** Scan auditd rules for docker-relevant paths (CIS 1.1.x). */
async function hostAuditRules() {
  const wanted = ['/usr/bin/dockerd', '/var/lib/docker', '/etc/docker', 'docker.service', 'docker.socket', '/etc/docker/daemon.json', '/etc/default/docker'];
  let text = '';
  try { text += await readFile(`${HOST_ROOT}/etc/audit/audit.rules`, 'utf8'); } catch { /* ignore */ }
  try {
    const dir = `${HOST_ROOT}/etc/audit/rules.d`;
    for (const f of await readdir(dir)) {
      if (f.endsWith('.rules')) { try { text += '\n' + await readFile(`${dir}/${f}`, 'utf8'); } catch { /* ignore */ } }
    }
  } catch { /* auditd not installed */ }
  const covered = wanted.filter((w) => text.includes(w));
  return { present: text.trim().length > 0, covered, wanted };
}

async function hostAudit() {
  const [daemonJson, etcDocker, daemonFile, sockRun, sockVarRun, auditRules, info] = await Promise.all([
    hostDaemonJson(),
    hostStat('/etc/docker'),
    hostStat('/etc/docker/daemon.json'),
    hostStat('/run/docker.sock'),
    hostStat('/var/run/docker.sock'),
    hostAuditRules(),
    docker.info().catch(() => ({})),
  ]);
  const sock = sockRun.exists ? sockRun : sockVarRun;
  return {
    nodeId: NODE_ID,
    hostname: NODE_HOSTNAME,
    daemonJson,
    files: { etcDocker, daemonFile, sock },
    auditRules,
    info: {
      LiveRestoreEnabled: info.LiveRestoreEnabled ?? null,
      ServerVersion: info.ServerVersion || null,
      SecurityOptions: info.SecurityOptions || [],
      LoggingDriver: info.LoggingDriver || null,
      CgroupDriver: info.CgroupDriver || null,
    },
  };
}

/* ----------------------------- export ------------------------------ */

async function commitAndStream(containerId, name, res) {
  const repo = `swarmdash-export/${name}`.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
  const tag = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const ref = `${repo}:${tag}`;
  const committed = await docker.getContainer(containerId).commit({ repo, tag, comment: 'swarmdash export', pause: true });
  const stream = await docker.getImage(ref).get();
  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${tag}.tar"`);
  stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
  const cleanup = () => docker.getImage(committed.Id).remove({ force: true }).catch(() => {});
  stream.on('end', cleanup);
  res.on('close', cleanup);
  stream.pipe(res);
}

/* -------------------------- containers ----------------------------- */

const SWARM_SVC_LABEL = 'com.docker.swarm.service.id';

async function listLocalContainers() {
  const list = await docker.listContainers({ all: true });
  return list.map((c) => ({
    id: c.Id,
    name: (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, ''),
    image: c.Image,
    imageId: c.ImageID,
    state: c.State,
    status: c.Status,
    created: c.Created,
    ports: (c.Ports || [])
      .filter((p) => p.PublicPort)
      .map((p) => ({ published: p.PublicPort, target: p.PrivatePort, protocol: p.Type })),
    swarm: Boolean(c.Labels && c.Labels[SWARM_SVC_LABEL]),
    service: (c.Labels && c.Labels['com.docker.swarm.service.name']) || null,
  }));
}

async function containerAction(id, action) {
  const c = docker.getContainer(id);
  if (action === 'start') return c.start();
  if (action === 'stop') return c.stop();
  if (action === 'restart') return c.restart();
  if (action === 'remove') return c.remove({ force: true });
  throw new Error(`Unbekannte Aktion: ${action}`);
}

/* ---------------------------- images ------------------------------- */

async function listLocalImages() {
  const [images, containers] = await Promise.all([
    docker.listImages(),
    docker.listContainers({ all: true }),
  ]);
  const usedIds = new Set(containers.map((c) => c.ImageID));
  return images.map((im) => ({
    id: im.Id,
    repoTags: (im.RepoTags || []).filter((t) => t && t !== '<none>:<none>'),
    size: im.Size,
    created: im.Created,
    dangling: !im.RepoTags || im.RepoTags.length === 0 || im.RepoTags[0] === '<none>:<none>',
    inUse: usedIds.has(im.Id),
  }));
}

/* ---------------------------- volumes ------------------------------ */

async function listLocalVolumes() {
  const [{ Volumes = [] }, containers] = await Promise.all([
    docker.listVolumes(),
    docker.listContainers({ all: true }),
  ]);
  const used = new Set();
  for (const c of containers) for (const m of (c.Mounts || [])) if (m.Type === 'volume' && m.Name) used.add(m.Name);
  return Volumes.map((v) => ({
    name: v.Name,
    driver: v.Driver,
    scope: v.Scope,
    mountpoint: v.Mountpoint,
    stack: v.Labels?.['com.docker.stack.namespace'] || null,
    inUse: used.has(v.Name),
  }));
}

/** Containers on this node that mount the given volume. */
async function localVolumeUsage(name) {
  const list = await docker.listContainers({ all: true });
  return list
    .filter((c) => (c.Mounts || []).some((m) => m.Name === name))
    .map((c) => ({
      id: c.Id,
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      state: c.State,
      swarm: Boolean(c.Labels?.['com.docker.swarm.service.id']),
      service: c.Labels?.['com.docker.swarm.service.name'] || null,
    }));
}

/** Bind mounts of standalone (non-swarm) containers on this node. */
async function localContainerBinds() {
  const list = await docker.listContainers({ all: true });
  const out = [];
  for (const c of list) {
    if (c.Labels && c.Labels['com.docker.swarm.service.id']) continue; // swarm task → covered by service spec
    for (const m of (c.Mounts || [])) {
      if (m.Type !== 'bind') continue;
      out.push({
        id: c.Id,
        name: (c.Names?.[0] || '').replace(/^\//, ''),
        state: c.State,
        source: m.Source,
        target: m.Destination,
        readOnly: m.RW === false,
      });
    }
  }
  return out;
}

async function imageExport(ref, res) {
  const stream = await docker.getImage(ref).get();
  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', `attachment; filename="${ref.replace(/[^\w.-]/g, '_')}.tar"`);
  stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
  stream.pipe(res);
}

async function imageImport(req, res) {
  const stream = await docker.loadImage(req);
  let out = '';
  stream.on('data', (d) => (out += d.toString()));
  stream.on('end', () => res.end(JSON.stringify({ ok: true, output: out.trim() })));
  stream.on('error', (e) => { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); });
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/* ------------------------------ http ------------------------------- */

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://agent');
    const json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };

    if (u.pathname === '/health') return json({ ok: true, nodeId: NODE_ID, hostname: NODE_HOSTNAME, version: AGENT_VERSION });
    if (u.pathname === '/metrics') return json(await collect());
    if (u.pathname === '/host-audit') return json(await hostAudit());
    if (u.pathname === '/containers') return json({ nodeId: NODE_ID, hostname: NODE_HOSTNAME, containers: await listLocalContainers() });
    if (u.pathname === '/images') return json({ nodeId: NODE_ID, hostname: NODE_HOSTNAME, images: await listLocalImages() });
    if (u.pathname === '/volumes') return json({ nodeId: NODE_ID, hostname: NODE_HOSTNAME, volumes: await listLocalVolumes() });

    if (u.pathname === '/volume-usage') {
      const name = u.searchParams.get('name');
      if (!name) { res.statusCode = 400; return json({ error: 'name fehlt' }); }
      return json({ nodeId: NODE_ID, hostname: NODE_HOSTNAME, containers: await localVolumeUsage(name) });
    }
    if (u.pathname === '/volume-size') {
      const name = u.searchParams.get('name');
      if (!name) { res.statusCode = 400; return json({ error: 'name fehlt' }); }
      return json({ bytes: await volumeSize(name) });
    }
    if (u.pathname === '/migration-preflight') {
      const source = u.searchParams.get('source');
      if (!source) { res.statusCode = 400; return json({ error: 'source fehlt' }); }
      return json({ nodeId: NODE_ID, hostname: NODE_HOSTNAME, ...(await migrationDiskProbe(source)) });
    }
    if (u.pathname === '/container-binds') {
      return json({ nodeId: NODE_ID, hostname: NODE_HOSTNAME, binds: await localContainerBinds() });
    }
    if (u.pathname === '/net-op' && req.method === 'POST') {
      // Node-local network operations (config-only halves of macvlan/ipvlan
      // swarm networks, interface discovery for the parent picker).
      const b = await readJson(req);
      const base = { nodeId: NODE_ID, hostname: NODE_HOSTNAME };
      try {
        if (b.op === 'interfaces') return json({ ...base, ...(await listInterfaces()) });
        if (b.op === 'config-get') return json({ ...base, config: await getConfigNetwork(b.name) });
        if (b.op === 'config-create') return json({ ...base, ...(await createConfigNetwork(b)) });
        if (b.op === 'config-remove') return json({ ...base, ...(await removeConfigNetwork(b.name)) });
        if (b.op === 'container-nets') return json({ ...base, nets: await containerNetworks(Array.isArray(b.ids) ? b.ids : []) });
      } catch (e) { res.statusCode = 400; return json({ ...base, error: e.message }); }
      res.statusCode = 400; return json({ error: 'Unbekannte Operation' });
    }
    if (u.pathname === '/container-state') {
      const id = u.searchParams.get('id');
      if (!id) { res.statusCode = 400; return json({ error: 'id fehlt' }); }
      return json(await containerState(id));
    }
    if (u.pathname === '/container-stats') {
      // Live CPU/RAM for one or more local containers. GET ?ids=a,b,c (or POST {ids}).
      let ids = (u.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (req.method === 'POST') { const b = await readJson(req); if (Array.isArray(b.ids)) ids = b.ids; }
      if (ids.length === 0) { res.statusCode = 400; return json({ error: 'ids fehlt' }); }
      return json({ nodeId: NODE_ID, hostname: NODE_HOSTNAME, stats: await containerStatsBatch(ids) });
    }
    if (u.pathname === '/container-migrate' && req.method === 'POST') {
      const { id, source, target, volume } = await readJson(req);
      if (!id || !source || !target || !volume) { res.statusCode = 400; return json({ error: 'id, source, target, volume erforderlich' }); }
      return json(await recreateWithVolume(id, source, target, volume));
    }
    if (u.pathname === '/trivy-scan' && req.method === 'POST') {
      const { ref } = await readJson(req);
      if (!ref) { res.statusCode = 400; return json({ error: 'ref erforderlich' }); }
      return json({ nodeId: NODE_ID, hostname: NODE_HOSTNAME, ...(await scanImageLocal(ref)) });
    }
    if (u.pathname === '/volume-action' && req.method === 'POST') {
      const { name, action, force, driver, labels, driverOpts } = await readJson(req);
      if (!name || !action) { res.statusCode = 400; return json({ error: 'name und action erforderlich' }); }
      if (action === 'remove') { await docker.getVolume(name).remove({ force: Boolean(force) }); return json({ ok: true }); }
      if (action === 'create') {
        const opts = { Name: name };
        if (driver) opts.Driver = driver;
        if (labels && Object.keys(labels).length) opts.Labels = labels;
        if (driverOpts && Object.keys(driverOpts).length) opts.DriverOpts = driverOpts;
        await docker.createVolume(opts);
        return json({ ok: true, name });
      }
      res.statusCode = 400; return json({ error: 'Unbekannte Volume-Aktion' });
    }
    if (u.pathname === '/volume-export') {
      const name = u.searchParams.get('name');
      if (!name) { res.statusCode = 400; return json({ error: 'name fehlt' }); }
      const stream = await exportVolume(name);
      res.setHeader('Content-Type', 'application/x-tar');
      stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
      stream.pipe(res);
      return;
    }
    if (u.pathname === '/volume-import' && req.method === 'POST') {
      const name = u.searchParams.get('name');
      if (!name) { res.statusCode = 400; return json({ error: 'name fehlt' }); }
      const clean = u.searchParams.get('clean') === '1';
      await importVolume(name, req, { clean });
      return json({ ok: true });
    }
    if (u.pathname === '/volume-copy' && req.method === 'POST') {
      const { src, dst, clean } = await readJson(req);
      if (!src || !dst) { res.statusCode = 400; return json({ error: 'src und dst erforderlich' }); }
      return json(await volumeCopyLocal(src, dst, { clean: Boolean(clean) }));
    }

    if (u.pathname === '/container-config') {
      const id = u.searchParams.get('id');
      if (!id) { res.statusCode = 400; return json({ error: 'id fehlt' }); }
      return json(await containerConfig(id));
    }
    if (u.pathname === '/container-top') {
      const id = u.searchParams.get('id');
      if (!id) { res.statusCode = 400; return json({ error: 'id fehlt' }); }
      return json(await containerTop(id, u.searchParams.get('ps') || 'aux'));
    }
    if (u.pathname === '/image-history') {
      const ref = u.searchParams.get('ref');
      if (!ref) { res.statusCode = 400; return json({ error: 'ref fehlt' }); }
      return json(await imageHistory(ref));
    }
    if (u.pathname === '/fs-list') {
      const id = u.searchParams.get('id');
      if (!id) { res.statusCode = 400; return json({ error: 'id fehlt' }); }
      return json(await fsList(id, u.searchParams.get('path') || '/'));
    }
    if (u.pathname === '/fs-read') {
      const id = u.searchParams.get('id');
      const p = u.searchParams.get('path');
      if (!id || !p) { res.statusCode = 400; return json({ error: 'id und path erforderlich' }); }
      return json(await fsRead(id, p));
    }
    if (u.pathname === '/fs-op' && req.method === 'POST') {
      const { id, op, path, contentB64 } = await readJson(req);
      if (!id || !op || !path) { res.statusCode = 400; return json({ error: 'id, op, path erforderlich' }); }
      return json(await fsOp(id, op, path, { contentB64 }));
    }
    if (u.pathname === '/vol-fs-list') {
      const volume = u.searchParams.get('volume');
      if (!volume) { res.statusCode = 400; return json({ error: 'volume fehlt' }); }
      return json(await volumeFsList(volume, u.searchParams.get('path') || '/'));
    }
    if (u.pathname === '/vol-fs-read') {
      const volume = u.searchParams.get('volume');
      const p = u.searchParams.get('path');
      if (!volume || !p) { res.statusCode = 400; return json({ error: 'volume und path erforderlich' }); }
      return json(await volumeFsRead(volume, p));
    }
    if (u.pathname === '/vol-fs-op' && req.method === 'POST') {
      const { volume, op, path, contentB64 } = await readJson(req);
      if (!volume || !op || !path) { res.statusCode = 400; return json({ error: 'volume, op, path erforderlich' }); }
      return json(await volumeFsOp(volume, op, path, { contentB64 }));
    }
    if (u.pathname === '/container-recreate' && req.method === 'POST') {
      const { id, patch } = await readJson(req);
      if (!id) { res.statusCode = 400; return json({ error: 'id fehlt' }); }
      return json(await recreateContainer(id, patch || {}));
    }
    if (u.pathname === '/container-action' && req.method === 'POST') {
      const { id, action } = await readJson(req);
      if (!id || !action) { res.statusCode = 400; return json({ error: 'id und action erforderlich' }); }
      await containerAction(id, action);
      return json({ ok: true });
    }
    if (u.pathname === '/image-action' && req.method === 'POST') {
      const { id, action, force } = await readJson(req);
      if (action === 'remove') { await docker.getImage(id).remove({ force: Boolean(force) }); return json({ ok: true }); }
      res.statusCode = 400; return json({ error: 'Unbekannte Image-Aktion' });
    }
    if (u.pathname === '/image-prune' && req.method === 'POST') {
      const { all } = await readJson(req);
      const r = await docker.pruneImages({ filters: all ? {} : { dangling: { true: true } } });
      return json({ ok: true, reclaimed: r.SpaceReclaimed || 0, deleted: (r.ImagesDeleted || []).length });
    }
    if (u.pathname === '/image-export') {
      const ref = u.searchParams.get('image');
      if (!ref) { res.statusCode = 400; return json({ error: 'image fehlt' }); }
      return imageExport(ref, res);
    }
    if (u.pathname === '/image-import' && req.method === 'POST') {
      return imageImport(req, res);
    }
    if (u.pathname === '/image-pull' && req.method === 'POST') {
      const { ref, authconfig } = await readJson(req);
      if (!ref) { res.statusCode = 400; return json({ error: 'ref fehlt' }); }
      await new Promise((resolve, reject) => {
        docker.pull(ref, authconfig ? { authconfig } : {}, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (e, o) => (e ? reject(e) : resolve(o)));
        });
      });
      return json({ ok: true });
    }
    if (u.pathname === '/export') {
      const id = u.searchParams.get('container');
      const name = u.searchParams.get('name') || 'service';
      if (!id) { res.statusCode = 400; res.end('{"error":"container fehlt"}'); return; }
      await commitAndStream(id, name, res);
      return;
    }
    res.statusCode = 404;
    res.end('{"error":"not found"}');
  } catch (e) {
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
    else res.destroy();
  }
});

/* --------------------------- console (WS) -------------------------- */

const wss = new WebSocketServer({ server, path: '/exec' });

wss.on('connection', async (ws, req) => {
  const u = new URL(req.url, 'http://agent');
  const id = u.searchParams.get('container');
  const shell = u.searchParams.get('shell') || '/bin/sh';
  const notify = (t, m) => ws.readyState === 1 && ws.send(JSON.stringify({ __ctl: t, message: m }));

  if (!id) { notify('error', 'container-Parameter fehlt'); return ws.close(); }

  let stream;
  try {
    const exec = await docker.getContainer(id).exec({
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
      Cmd: [shell], Env: ['TERM=xterm-256color'],
    });
    stream = await exec.start({ hijack: true, stdin: true });
    notify('ready', `Agent-Konsole ${NODE_HOSTNAME}:${id.slice(0, 12)} (${shell})`);
    stream.on('data', (c) => ws.readyState === 1 && ws.send(c.toString('utf8')));
    stream.on('end', () => notify('end'));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'input') stream.write(m.data);
      else if (m.type === 'resize') exec.resize({ h: m.rows, w: m.cols }).catch(() => {});
    });
  } catch (e) {
    notify('error', e.message);
    return ws.close();
  }
  ws.on('close', () => stream && typeof stream.destroy === 'function' && stream.destroy());
});

server.listen(PORT, () => {
  console.log(`Swarm Dashboard Agent auf :${PORT} — Node ${NODE_HOSTNAME} (${NODE_ID || 'unbekannt'})`);
});
