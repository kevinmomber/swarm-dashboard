import { docker, requireManager } from './docker.js';
import { Readable, Transform } from 'node:stream';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink, mkdtemp } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { listAgents, agentBaseForNode } from './metrics.js';
import { exportVolume, importVolume, volumeSize } from './volarchive.js';
import { containerState, recreateWithVolume, containerConfig, recreateContainer, containerTop, imageHistory, fsList, fsRead, fsOp, volumeFsList, volumeFsRead, volumeFsOp } from './containerops.js';
import { scanImageLocal } from './security.js';

const SWARM_SVC_LABEL = 'com.docker.swarm.service.id';

async function fetchWithTimeout(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------- containers ---------------------------- */

/** Standalone (non-service) containers across the cluster. */
export async function listContainers() {
  await requireManager();
  const agents = await listAgents();

  if (agents.length) {
    const out = [];
    await Promise.all(
      agents.map(async (a) => {
        try {
          const r = await fetchWithTimeout(`${a.base}/containers`);
          if (!r.ok) return;
          const j = await r.json();
          for (const c of j.containers) {
            // Show standalone containers, plus swarm task containers that are
            // NOT running (old/exited tasks) so they can be removed to free images.
            const running = ['running', 'paused', 'restarting'].includes(c.state);
            if (!c.swarm || !running) out.push({ ...c, node: j.hostname, nodeId: j.nodeId });
          }
        } catch { /* agent unreachable */ }
      })
    );
    return out;
  }

  // Fallback: connected node only.
  const info = await docker.info();
  const list = await docker.listContainers({ all: true });
  const RUNNING = new Set(['running', 'paused', 'restarting']);
  return list
    .filter((c) => {
      const isSwarm = Boolean(c.Labels && c.Labels[SWARM_SVC_LABEL]);
      // Standalone containers always; swarm containers only when stopped.
      return !isSwarm || !RUNNING.has(c.State);
    })
    .map((c) => ({
      id: c.Id,
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      imageId: c.ImageID,
      state: c.State,
      status: c.Status,
      created: c.Created,
      ports: (c.Ports || []).filter((p) => p.PublicPort).map((p) => ({ published: p.PublicPort, target: p.PrivatePort, protocol: p.Type })),
      swarm: Boolean(c.Labels && c.Labels[SWARM_SVC_LABEL]),
      service: (c.Labels && c.Labels['com.docker.swarm.service.name']) || null,
      node: info.Name,
      nodeId: info.Swarm?.NodeID || null,
    }));
}

export async function containerAction(nodeId, id, action) {
  await requireManager();
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const r = await fetchWithTimeout(`${base}/container-action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }),
    });
    if (!r.ok) throw new Error(`Agent-Aktion fehlgeschlagen (HTTP ${r.status})`);
    return r.json();
  }
  const c = docker.getContainer(id);
  if (action === 'start') await c.start();
  else if (action === 'stop') await c.stop();
  else if (action === 'restart') await c.restart();
  else if (action === 'remove') await c.remove({ force: true });
  else throw new Error(`Unbekannte Aktion: ${action}`);
  return { ok: true };
}

/** Get the editable config of a standalone container (routes to the owning node). */
export async function getContainerConfig(nodeId, id) {
  await requireManager();
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const r = await fetchWithTimeout(`${base}/container-config?id=${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`Agent-Config fehlgeschlagen (HTTP ${r.status})`);
    return r.json();
  }
  return containerConfig(id);
}

/** Recreate a standalone container with an edited config (routes to the owning node). */
export async function recreateContainerOnNode(nodeId, id, patch) {
  await requireManager();
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const r = await fetchWithTimeout(`${base}/container-recreate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, patch }),
    });
    if (!r.ok) {
      let msg = `Agent-Recreate fehlgeschlagen (HTTP ${r.status})`;
      try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
      throw new Error(msg);
    }
    return r.json();
  }
  return recreateContainer(id, patch || {});
}

/* --- inspection tabs: processes, layers, filesystem (route to node) --- */

async function agentGet(nodeId, path, ms = 4000) {
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const r = await fetchWithTimeout(`${base}${path}`, {}, ms);
    if (!r.ok) {
      let msg = `Agent-Anfrage fehlgeschlagen (HTTP ${r.status})`;
      try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* keep */ }
      throw new Error(msg);
    }
    return r.json();
  }
  return null; // caller falls back to local
}

async function agentPost(nodeId, path, body, ms = 4000) {
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const r = await fetchWithTimeout(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, ms);
    if (!r.ok) {
      let msg = `Agent-Anfrage fehlgeschlagen (HTTP ${r.status})`;
      try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* keep */ }
      throw new Error(msg);
    }
    return r.json();
  }
  return null;
}

export async function containerTopOnNode(nodeId, id, ps = 'aux') {
  await requireManager();
  const viaAgent = await agentGet(nodeId, `/container-top?id=${encodeURIComponent(id)}&ps=${encodeURIComponent(ps)}`, 20000);
  return viaAgent ?? containerTop(id, ps);
}

export async function imageHistoryOnNode(nodeId, ref) {
  await requireManager();
  const viaAgent = await agentGet(nodeId, `/image-history?ref=${encodeURIComponent(ref)}`, 20000);
  return viaAgent ?? imageHistory(ref);
}

export async function fsListOnNode(nodeId, id, path) {
  await requireManager();
  const viaAgent = await agentGet(nodeId, `/fs-list?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path || '/')}`, 20000);
  return viaAgent ?? fsList(id, path || '/');
}

export async function fsReadOnNode(nodeId, id, path) {
  await requireManager();
  const viaAgent = await agentGet(nodeId, `/fs-read?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`, 30000);
  return viaAgent ?? fsRead(id, path);
}

export async function fsOpOnNode(nodeId, id, op, path, contentB64) {
  await requireManager();
  const viaAgent = await agentPost(nodeId, '/fs-op', { id, op, path, contentB64 }, 30000);
  return viaAgent ?? fsOp(id, op, path, { contentB64 });
}

export async function volumeFsListOnNode(nodeId, volume, path) {
  await requireManager();
  const viaAgent = await agentGet(nodeId, `/vol-fs-list?volume=${encodeURIComponent(volume)}&path=${encodeURIComponent(path || '/')}`, 60000);
  return viaAgent ?? volumeFsList(volume, path || '/');
}

export async function volumeFsReadOnNode(nodeId, volume, path) {
  await requireManager();
  const viaAgent = await agentGet(nodeId, `/vol-fs-read?volume=${encodeURIComponent(volume)}&path=${encodeURIComponent(path)}`, 60000);
  return viaAgent ?? volumeFsRead(volume, path);
}

export async function volumeFsOpOnNode(nodeId, volume, op, path, contentB64) {
  await requireManager();
  const viaAgent = await agentPost(nodeId, '/vol-fs-op', { volume, op, path, contentB64 }, 60000);
  return viaAgent ?? volumeFsOp(volume, op, path, { contentB64 });
}

/* ----------------------------- images ------------------------------ */

/** All images across the cluster (per node). */
export async function listImages() {
  await requireManager();
  const agents = await listAgents();

  if (agents.length) {
    const out = [];
    await Promise.all(
      agents.map(async (a) => {
        try {
          const r = await fetchWithTimeout(`${a.base}/images`);
          if (!r.ok) return;
          const j = await r.json();
          for (const im of j.images) out.push({ ...im, node: j.hostname, nodeId: j.nodeId });
        } catch { /* agent unreachable */ }
      })
    );
    return out;
  }

  // Fallback: connected node only.
  const info = await docker.info();
  const [images, containers] = await Promise.all([docker.listImages(), docker.listContainers({ all: true })]);
  const used = new Set(containers.map((c) => c.ImageID));
  return images.map((im) => ({
    id: im.Id,
    repoTags: (im.RepoTags || []).filter((t) => t && t !== '<none>:<none>'),
    size: im.Size,
    created: im.Created,
    dangling: !im.RepoTags || im.RepoTags[0] === '<none>:<none>',
    inUse: used.has(im.Id),
    node: info.Name,
    nodeId: info.Swarm?.NodeID || null,
  }));
}

/* ------------------------- image usage ----------------------------- */

/** Where a given image is used on its node: swarm services + containers.
 *  Services are swarm-wide (queried on the manager); containers are node-local
 *  (via the node agent, or the connected daemon as a fallback). */
export async function imageUsage(nodeId, id, ref) {
  await requireManager();

  // Swarm services referencing this image (by repo:tag, ignoring the @digest).
  let services = [];
  try {
    const svcs = await docker.listServices();
    services = svcs
      .filter((s) => {
        const img = s.Spec?.TaskTemplate?.ContainerSpec?.Image || '';
        const base = img.split('@')[0];
        return Boolean(ref) && (img === ref || base === ref);
      })
      .map((s) => ({
        id: s.ID,
        name: s.Spec?.Name || s.ID,
        image: (s.Spec?.TaskTemplate?.ContainerSpec?.Image || '').split('@')[0],
        stack: s.Spec?.Labels?.['com.docker.stack.namespace'] || null,
      }));
  } catch { /* services not listable */ }

  // Containers on the node using this image (matched by image id or ref).
  let containers = [];
  const base = await agentBaseForNode(nodeId);
  if (base) {
    try {
      const r = await fetchWithTimeout(`${base}/containers`);
      if (r.ok) {
        const j = await r.json();
        containers = (j.containers || [])
          .filter((c) => c.imageId === id || c.image === ref)
          .map((c) => ({ id: c.id, name: c.name, image: c.image, state: c.state, swarm: c.swarm, service: c.service || null }));
      }
    } catch { /* agent unreachable */ }
  } else {
    const list = await docker.listContainers({ all: true });
    containers = list
      .filter((c) => c.ImageID === id || c.Image === ref)
      .map((c) => ({
        id: c.Id,
        name: (c.Names?.[0] || '').replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        swarm: Boolean(c.Labels?.['com.docker.swarm.service.id']),
        service: c.Labels?.['com.docker.swarm.service.name'] || null,
      }));
  }

  return { services, containers };
}

/* ----------------------------- volumes ----------------------------- */

/** All volumes across the cluster (per node). Volumes are node-local, so we
 *  fan out to every node agent AND always include the connected (manager)
 *  node's own volumes directly — so the manager's volumes appear even if it
 *  runs no agent, and old agents that lack the /volumes endpoint (pre-1.8.1)
 *  simply contribute nothing instead of hiding everything. Results are
 *  deduplicated per (nodeId, name). */
export async function listVolumes() {
  await requireManager();
  const agents = await listAgents();

  const out = [];
  const seen = new Set();
  const add = (v) => {
    const key = `${v.nodeId || v.node || ''}|${v.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  // 1) Connected (manager) node's own volumes — direct API, no agent required.
  try {
    const info = await docker.info();
    const [{ Volumes = [] }, containers] = await Promise.all([
      docker.listVolumes(),
      docker.listContainers({ all: true }),
    ]);
    const used = new Set();
    for (const c of containers) for (const m of (c.Mounts || [])) if (m.Type === 'volume' && m.Name) used.add(m.Name);
    for (const v of Volumes) {
      add({
        name: v.Name,
        driver: v.Driver,
        scope: v.Scope,
        mountpoint: v.Mountpoint,
        stack: v.Labels?.['com.docker.stack.namespace'] || null,
        inUse: used.has(v.Name),
        node: info.Name,
        nodeId: info.Swarm?.NodeID || null,
      });
    }
  } catch { /* connected daemon not listable */ }

  // 2) Every reachable node agent's volumes (other nodes; also re-confirms manager).
  await Promise.all(
    agents.map(async (a) => {
      try {
        const r = await fetchWithTimeout(`${a.base}/volumes`);
        if (!r.ok) return; // pre-1.8.1 agent without /volumes → skip this node
        const j = await r.json();
        for (const v of (j.volumes || [])) add({ ...v, node: j.hostname, nodeId: j.nodeId });
      } catch { /* agent unreachable */ }
    })
  );

  return out;
}

/* --------------------------- volume ops ---------------------------- */

/** Where a volume is used: swarm services (by mount source) + node containers. */
export async function volumeUsage(nodeId, name) {
  await requireManager();

  let services = [];
  try {
    const svcs = await docker.listServices();
    services = svcs
      .filter((s) => (s.Spec?.TaskTemplate?.ContainerSpec?.Mounts || [])
        .some((m) => m.Type === 'volume' && m.Source === name))
      .map((s) => ({
        id: s.ID,
        name: s.Spec?.Name || s.ID,
        stack: s.Spec?.Labels?.['com.docker.stack.namespace'] || null,
      }));
  } catch { /* services not listable */ }

  let containers = [];
  const base = await agentBaseForNode(nodeId);
  if (base) {
    try {
      const r = await fetchWithTimeout(`${base}/volume-usage?name=${encodeURIComponent(name)}`);
      if (r.ok) containers = (await r.json()).containers || [];
    } catch { /* agent unreachable */ }
  } else {
    const list = await docker.listContainers({ all: true });
    containers = list
      .filter((c) => (c.Mounts || []).some((m) => m.Name === name))
      .map((c) => ({
        id: c.Id,
        name: (c.Names?.[0] || '').replace(/^\//, ''),
        state: c.State,
        swarm: Boolean(c.Labels?.['com.docker.swarm.service.id']),
        service: c.Labels?.['com.docker.swarm.service.name'] || null,
      }));
  }

  return { services, containers };
}

export async function volumeRemove(nodeId, name, force) {
  await requireManager();
  if (!name) throw new Error('name erforderlich');
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const r = await fetchWithTimeout(`${base}/volume-action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, action: 'remove', force }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `Agent-Aktion fehlgeschlagen (HTTP ${r.status})`);
    }
    return r.json();
  }
  await docker.getVolume(name).remove({ force: Boolean(force) });
  return { ok: true };
}

/** Create a new volume on the local (manager) node or a remote node via its agent. */
export async function volumeCreate(nodeId, { name, driver, labels, driverOpts } = {}) {
  await requireManager();
  if (!name) throw new Error('name erforderlich');
  if (!/^[\w][\w.-]*$/.test(name)) throw new Error('Ungültiger Volumename');
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const r = await fetchWithTimeout(`${base}/volume-action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, action: 'create', driver, labels, driverOpts }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `Agent-Aktion fehlgeschlagen (HTTP ${r.status})`);
    }
    return r.json();
  }
  const opts = { Name: name };
  if (driver) opts.Driver = driver;
  if (labels && Object.keys(labels).length) opts.Labels = labels;
  if (driverOpts && Object.keys(driverOpts).length) opts.DriverOpts = driverOpts;
  await docker.createVolume(opts);
  return { ok: true, name };
}

/** Best-effort apparent size of a volume (bytes) — local or via node agent. */
async function volumeSizeOf(nodeId, name, localId) {
  const local = !nodeId || nodeId === localId;
  if (local) { try { return await volumeSize(name); } catch { return null; } }
  const base = await agentBaseForNode(nodeId);
  if (!base) return null;
  try {
    const r = await fetchWithTimeout(`${base}/volume-size?name=${encodeURIComponent(name)}`, {}, 30000);
    if (r.ok) return (await r.json()).bytes ?? null;
  } catch { /* ignore */ }
  return null;
}

/**
 * Duplicate a volume's contents into a new volume, possibly on another node.
 * Optional callbacks report progress: onSize(totalBytes|null) once, then
 * onBytes(copiedBytes) as the tar stream flows through the manager.
 */
export async function volumeDuplicate({ srcNodeId, name, dstNodeId, newName, onSize, onBytes }) {
  await requireManager();
  if (!name || !newName) throw new Error('name und newName erforderlich');
  if (!/^[\w][\w.-]*$/.test(newName)) throw new Error('Ungültiger Ziel-Volumename');

  const info = await docker.info();
  const localId = info.Swarm?.NodeID || null;
  const srcLocal = !srcNodeId || srcNodeId === localId;
  const dstLocal = !dstNodeId || dstNodeId === localId;
  const srcBase = srcLocal ? null : await agentBaseForNode(srcNodeId);
  const dstBase = dstLocal ? null : await agentBaseForNode(dstNodeId);
  if (!srcLocal && !srcBase) throw new Error('Quell-Node nicht erreichbar (Agent erforderlich)');
  if (!dstLocal && !dstBase) throw new Error('Ziel-Node nicht erreichbar (Agent erforderlich)');

  // Best-effort total size up front so the client can show a percentage.
  if (onSize) onSize(await volumeSizeOf(srcNodeId, name, localId).catch(() => null));

  // Obtain the source volume as a tar stream.
  let srcStream;
  if (srcLocal) {
    srcStream = await exportVolume(name);
  } else {
    const r = await fetch(`${srcBase}/volume-export?name=${encodeURIComponent(name)}`);
    if (!r.ok || !r.body) throw new Error(`Quell-Export fehlgeschlagen (HTTP ${r.status})`);
    srcStream = Readable.fromWeb(r.body);
  }

  // Count bytes as they stream through the manager. A Transform (not a
  // 'data' listener) preserves backpressure so no chunk is dropped.
  let stream = srcStream;
  if (onBytes) {
    let copied = 0, last = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        copied += chunk.length;
        const now = Date.now();
        if (now - last > 200) { last = now; onBytes(copied); }
        cb(null, chunk);
      },
      flush(cb) { onBytes(copied); cb(); },
    });
    srcStream.on('error', (e) => counter.destroy(e));
    srcStream.pipe(counter);
    stream = counter;
  }

  // Write into the destination volume.
  if (dstLocal) {
    await importVolume(newName, stream);
  } else {
    const r = await fetch(`${dstBase}/volume-import?name=${encodeURIComponent(newName)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-tar' }, body: stream, duplex: 'half',
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `Ziel-Import fehlgeschlagen (HTTP ${r.status})`);
    }
  }
  return { ok: true, name: newName, srcNodeId: srcNodeId || localId, dstNodeId: dstNodeId || localId };
}

/**
 * Export a volume's contents as a tar stream (Docker archive; entries prefixed
 * "vol/"). Works for the local (manager) node or a remote node via its agent.
 * The returned stream can be piped straight to an HTTP response for download.
 */
export async function volumeExport(nodeId, name) {
  await requireManager();
  if (!name) throw new Error('name erforderlich');
  const info = await docker.info();
  const localId = info.Swarm?.NodeID || null;
  const local = !nodeId || nodeId === localId;
  if (local) return await exportVolume(name);
  const base = await agentBaseForNode(nodeId);
  if (!base) throw new Error('Node nicht erreichbar (Agent erforderlich)');
  const r = await fetch(`${base}/volume-export?name=${encodeURIComponent(name)}`);
  if (!r.ok || !r.body) throw new Error(`Export fehlgeschlagen (HTTP ${r.status})`);
  return Readable.fromWeb(r.body);
}

/**
 * Import a tar stream (Docker archive with "vol/"-prefixed entries, as produced
 * by volumeExport) into a volume, creating it if needed. Local or remote node.
 */
export async function volumeImport(nodeId, name, tarStream) {
  await requireManager();
  if (!name) throw new Error('name erforderlich');
  if (!/^[\w][\w.-]*$/.test(name)) throw new Error('Ungültiger Volumename');
  const info = await docker.info();
  const localId = info.Swarm?.NodeID || null;
  const local = !nodeId || nodeId === localId;
  if (local) { await importVolume(name, tarStream); return { ok: true, name }; }
  const base = await agentBaseForNode(nodeId);
  if (!base) throw new Error('Node nicht erreichbar (Agent erforderlich)');
  const r = await fetch(`${base}/volume-import?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-tar' }, body: tarStream, duplex: 'half',
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `Import fehlgeschlagen (HTTP ${r.status})`);
  }
  return { ok: true, name };
}

/* --------------------------- bind analysis ------------------------- */

/** Read-only migratability assessment for a bind mount source (host path). */
function assessBind(source) {
  if (!source || !source.startsWith('/')) return { migratable: 'skip', reason: 'Kein absoluter Host-Pfad' };
  const s = source.replace(/\/+$/, '') || '/';
  // Docker socket in any spelling (incl. Docker Desktop's proxy socket).
  if (/docker(\.proxy)?\.sock$/.test(s)) return { migratable: 'skip', reason: 'Docker-Socket' };
  // Docker Desktop maps real host binds under these prefixes → treat as normal host data.
  const desktopHost = ['/run/desktop/mnt/host', '/host_mnt'];
  if (desktopHost.some((p) => s === p || s.startsWith(p + '/'))) return { migratable: 'ok', reason: null };
  if (s === '/') return { migratable: 'skip', reason: 'Root-Dateisystem' };
  const badPrefixes = ['/proc', '/sys', '/dev', '/etc', '/run', '/var/run', '/boot'];
  if (badPrefixes.some((p) => s === p || s.startsWith(p + '/'))) return { migratable: 'skip', reason: `Systempfad (${s})` };
  return { migratable: 'ok', reason: null };
}

/** All bind mounts across swarm services and standalone containers (read-only). */
export async function listBindMounts() {
  await requireManager();
  const out = [];

  // Running-task count + node per service (to enforce/guide the stopped-migration).
  const taskRunning = {};
  const taskNode = {};
  try {
    const tasks = await docker.listTasks();
    for (const t of tasks) {
      if (t.Status?.State === 'running' || t.DesiredState === 'running') {
        taskRunning[t.ServiceID] = (taskRunning[t.ServiceID] || 0) + 1;
        if (t.NodeID && !taskNode[t.ServiceID]) taskNode[t.ServiceID] = t.NodeID;
      }
    }
  } catch { /* ignore */ }

  // Swarm services (spec-level binds).
  try {
    const svcs = await docker.listServices();
    for (const s of svcs) {
      const spec = s.Spec || {};
      const mounts = spec.TaskTemplate?.ContainerSpec?.Mounts || [];
      const mode = spec.Mode?.Global ? 'global' : 'replicated';
      const replicas = spec.Mode?.Replicated?.Replicas ?? null;
      const multiNode = mode === 'global' || (replicas != null && replicas > 1);
      const running = (taskRunning[s.ID] || 0) > 0;
      for (const m of mounts) {
        if (m.Type !== 'bind') continue;
        const a = assessBind(m.Source);
        let { migratable, reason } = a;
        if (migratable === 'ok' && multiNode) {
          migratable = 'caution';
          reason = 'Repliziert/global — ein Named Volume wäre node-lokal (Daten je Node getrennt)';
        }
        out.push({
          kind: 'service', id: s.ID, name: spec.Name,
          stack: spec.Labels?.['com.docker.stack.namespace'] || null,
          node: null, nodeId: null, taskNodeId: taskNode[s.ID] || null, mode, replicas, running,
          source: m.Source, target: m.Target, readOnly: Boolean(m.ReadOnly),
          migratable, reason,
        });
      }
    }
  } catch { /* services not listable */ }

  // Standalone containers per node (agents) or connected node fallback.
  const agents = await listAgents();
  const collect = (binds, node, nodeId) => {
    for (const b of binds) {
      const a = assessBind(b.source);
      out.push({
        kind: 'container', id: b.id, name: b.name, stack: null,
        node, nodeId, mode: null, replicas: null, running: b.state === 'running',
        source: b.source, target: b.target, readOnly: Boolean(b.readOnly),
        migratable: a.migratable, reason: a.reason,
      });
    }
  };
  if (agents.length) {
    await Promise.all(agents.map(async (ag) => {
      try {
        const r = await fetchWithTimeout(`${ag.base}/container-binds`);
        if (r.ok) { const j = await r.json(); collect(j.binds || [], j.hostname, j.nodeId); }
      } catch { /* agent unreachable */ }
    }));
  } else {
    const info = await docker.info();
    const list = await docker.listContainers({ all: true });
    const binds = [];
    for (const c of list) {
      if (c.Labels && c.Labels['com.docker.swarm.service.id']) continue;
      for (const m of (c.Mounts || [])) {
        if (m.Type === 'bind') binds.push({ id: c.Id, name: (c.Names?.[0] || '').replace(/^\//, ''), source: m.Source, target: m.Destination, readOnly: m.RW === false, state: c.State });
      }
    }
    collect(binds, info.Name, info.Swarm?.NodeID || null);
  }

  return out;
}

/* --------------------------- migration ----------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function containerStateOf(nodeId, id, localId) {
  const local = !nodeId || nodeId === localId;
  if (local) return containerState(id);
  const base = await agentBaseForNode(nodeId);
  if (!base) throw new Error('Node nicht erreichbar (Agent erforderlich)');
  const r = await fetchWithTimeout(`${base}/container-state?id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`Status-Abfrage fehlgeschlagen (HTTP ${r.status})`);
  return r.json();
}

async function stopContainerOf(nodeId, id, localId) {
  const local = !nodeId || nodeId === localId;
  if (local) { await docker.getContainer(id).stop().catch((e) => { if (!/not running|already/i.test(e.message)) throw e; }); return; }
  const base = await agentBaseForNode(nodeId);
  const r = await fetchWithTimeout(`${base}/container-action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: 'stop' }),
  }, 60000);
  if (!r.ok) throw new Error(`Container stoppen fehlgeschlagen (HTTP ${r.status})`);
}

/** Migrate a standalone container's bind mount to a named volume.
 *  With stop=true the container is stopped first; otherwise it must already be stopped. */
export async function migrateContainer({ nodeId, id, source, target, newName, stop, onPhase, onSize, onBytes }) {
  await requireManager();
  if (!id || !source || !target || !newName) throw new Error('id, source, target, newName erforderlich');
  const info = await docker.info();
  const localId = info.Swarm?.NodeID || null;

  onPhase?.('check');
  let st = await containerStateOf(nodeId, id, localId);
  if (st.running) {
    if (!stop) throw new Error('Container läuft — Stoppen nicht bestätigt');
    onPhase?.('stop');
    await stopContainerOf(nodeId, id, localId);
    for (let i = 0; i < 40 && st.running; i++) { await sleep(500); st = await containerStateOf(nodeId, id, localId); }
    if (st.running) throw new Error('Container konnte nicht gestoppt werden');
  }

  onPhase?.('copy');
  await volumeDuplicate({ srcNodeId: nodeId, name: source, dstNodeId: nodeId, newName, onSize, onBytes });

  onPhase?.('finalize');
  const local = !nodeId || nodeId === localId;
  let result;
  if (local) {
    result = await recreateWithVolume(id, source, target, newName);
  } else {
    const base = await agentBaseForNode(nodeId);
    const r = await fetchWithTimeout(`${base}/container-migrate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source, target, volume: newName }),
    }, 120000);
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Container-Neuaufbau fehlgeschlagen (HTTP ${r.status})`); }
    result = await r.json();
  }
  onPhase?.('done');
  return { ok: true, volume: newName, kind: 'container', stopped: true, ...result };
}

/** Migrate a swarm service's bind mount to a named volume.
 *  With stop=true the service is scaled to 0 first; otherwise it must already be stopped. */
export async function migrateService({ id, source, target, newName, nodeId, stop, onPhase, onSize, onBytes }) {
  await requireManager();
  if (!id || !source || !target || !newName || !nodeId) throw new Error('id, source, target, newName, nodeId erforderlich');

  onPhase?.('check');
  const svc = await docker.getService(id).inspect();
  const origReplicas = svc.Spec.Mode?.Replicated?.Replicas ?? null;
  const countRunning = async () => (await docker.listTasks({ filters: { service: [id] } }))
    .filter((t) => t.Status?.State === 'running' || t.DesiredState === 'running').length;
  let running = await countRunning();
  let didStop = false;
  if (running > 0) {
    if (!stop) throw new Error('Service läuft — Stoppen nicht bestätigt');
    if (svc.Spec.Mode?.Global) throw new Error('Globaler Service kann nicht automatisch gestoppt werden — bitte manuell entfernen/anpassen');
    onPhase?.('stop');
    didStop = true;
    const spec0 = svc.Spec;
    if (spec0.Mode?.Replicated) spec0.Mode.Replicated.Replicas = 0;
    await docker.getService(id).update({ ...spec0, version: svc.Version.Index });
    for (let i = 0; i < 60; i++) {
      const run = (await docker.listTasks({ filters: { service: [id] } })).filter((t) => t.Status?.State === 'running').length;
      if (run === 0) break;
      await sleep(750);
    }
  }

  onPhase?.('copy');
  await volumeDuplicate({ srcNodeId: nodeId, name: source, dstNodeId: nodeId, newName, onSize, onBytes });

  onPhase?.('finalize');
  const fresh = await docker.getService(id).inspect();
  const spec = fresh.Spec;
  const version = fresh.Version.Index;
  const mounts = spec.TaskTemplate?.ContainerSpec?.Mounts || [];
  let replaced = false;
  spec.TaskTemplate.ContainerSpec.Mounts = mounts.map((m) => {
    if (m.Type === 'bind' && m.Source === source && m.Target === target) {
      replaced = true;
      return { Type: 'volume', Source: newName, Target: target, ReadOnly: Boolean(m.ReadOnly) };
    }
    return m;
  });
  if (!replaced) throw new Error('Bind-Mount in der Service-Spec nicht gefunden');
  // Named local volumes are node-local: pin the service to the node that holds
  // the freshly-populated volume, otherwise a task scheduled on another node
  // would get a new EMPTY volume and run without the migrated data.
  const placement = spec.TaskTemplate.Placement || (spec.TaskTemplate.Placement = {});
  const constraints = (placement.Constraints || []).filter((c) => !/^\s*node\.(id|hostname)\s*==/i.test(c));
  constraints.push(`node.id==${nodeId}`);
  placement.Constraints = constraints;
  // Restore the original replica count so the service comes back up with the new volume.
  if (didStop && spec.Mode?.Replicated && origReplicas != null) {
    spec.Mode.Replicated.Replicas = origReplicas;
  }
  await docker.getService(id).update({ ...spec, version });
  onPhase?.('done');
  const replicas = spec.Mode?.Replicated?.Replicas ?? null;
  return { ok: true, volume: newName, kind: 'service', service: spec.Name, replicas, restored: didStop, pinnedNode: nodeId };
}

/* --------------------------- security ------------------------------ */

/** Scannable targets = unique images per node, annotated with using services/containers. */
export async function securityTargets() {
  await requireManager();
  const images = await listImages(); // per-node, has repoTags/id/node/nodeId/inUse

  // Map image → services (by repo:tag) and standalone containers (by image).
  const svcByImage = new Map();
  try {
    const svcs = await docker.listServices();
    for (const s of svcs) {
      const img = (s.Spec?.TaskTemplate?.ContainerSpec?.Image || '').split('@')[0];
      if (!img) continue;
      if (!svcByImage.has(img)) svcByImage.set(img, []);
      svcByImage.get(img).push(s.Spec?.Name || s.ID);
    }
  } catch { /* ignore */ }

  const out = [];
  for (const im of images) {
    const ref = (im.repoTags && im.repoTags[0]) || im.id;
    if (!ref) continue;
    const usedBy = [];
    for (const t of (im.repoTags || [])) {
      const svcs = svcByImage.get(t.split('@')[0]);
      if (svcs) for (const n of svcs) usedBy.push({ kind: 'service', name: n });
    }
    out.push({
      ref,
      id: im.id,
      repoTags: im.repoTags || [],
      node: im.node,
      nodeId: im.nodeId,
      size: im.size,
      dangling: im.dangling,
      inUse: im.inUse,
      usedBy,
    });
  }
  return out;
}

/** Scan one image on its node (via agent) or on the connected daemon. */
export async function scanImage(nodeId, ref) {
  await requireManager();
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const r = await fetchWithTimeout(`${base}/trivy-scan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }),
    }, 600000);
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Agent-Scan fehlgeschlagen (HTTP ${r.status})`); }
    return r.json();
  }
  return scanImageLocal(ref);
}

export async function imageAction(nodeId, id, action, force) {
  await requireManager();
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const r = await fetchWithTimeout(`${base}/image-action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, force }),
    });
    if (!r.ok) throw new Error(`Agent-Aktion fehlgeschlagen (HTTP ${r.status})`);
    return r.json();
  }
  if (action === 'remove') { await docker.getImage(id).remove({ force: Boolean(force) }); return { ok: true }; }
  throw new Error('Unbekannte Image-Aktion');
}

export async function imagePrune(nodeId, all) {
  await requireManager();
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const r = await fetchWithTimeout(`${base}/image-prune`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: Boolean(all) }),
    }, 30000);
    if (!r.ok) throw new Error(`Prune fehlgeschlagen (HTTP ${r.status})`);
    return r.json();
  }
  const res = await docker.pruneImages({ filters: all ? {} : { dangling: { true: true } } });
  return { ok: true, reclaimed: res.SpaceReclaimed || 0, deleted: (res.ImagesDeleted || []).length };
}

export async function imageExport(nodeId, ref, res) {
  await requireManager();
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const upstream = await fetch(`${base}/image-export?image=${encodeURIComponent(ref)}`);
    if (!upstream.ok || !upstream.body) throw Object.assign(new Error(`Agent-Export fehlgeschlagen (HTTP ${upstream.status})`), { status: 502 });
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', upstream.headers.get('content-disposition') || `attachment; filename="image.tar"`);
    await new Promise((resolve, reject) => {
      const s = Readable.fromWeb(upstream.body);
      s.on('error', reject); res.on('close', resolve); s.on('end', resolve); s.pipe(res);
    });
    return;
  }
  const stream = await docker.getImage(ref).get();
  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', `attachment; filename="${ref.replace(/[^\w.-]/g, '_')}.tar"`);
  await new Promise((resolve, reject) => {
    stream.on('error', reject); res.on('close', resolve); stream.on('end', resolve); stream.pipe(res);
  });
}

export async function imageImport(nodeId, req, res) {
  await requireManager();
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const upstream = await fetch(`${base}/image-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-tar' },
      body: Readable.toWeb(req),
      duplex: 'half',
    });
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = upstream.status;
    res.end(text || '{"ok":true}');
    return;
  }
  const stream = await docker.loadImage(req);
  let out = '';
  await new Promise((resolve) => {
    stream.on('data', (d) => (out += d.toString()));
    stream.on('end', resolve);
    stream.on('error', resolve);
  });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, output: out.trim() }));
}

/** Load a saved image tarball (from a local file path) onto one node. */
async function loadTarToNode(nodeId, filePath) {
  const base = await agentBaseForNode(nodeId);
  if (base) {
    const upstream = await fetch(`${base}/image-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-tar' },
      body: Readable.toWeb(createReadStream(filePath)),
      duplex: 'half',
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      let msg = `HTTP ${upstream.status}`;
      try { msg = JSON.parse(text)?.error || msg; } catch { /* keep */ }
      throw new Error(msg);
    }
    return text;
  }
  const stream = await docker.loadImage(createReadStream(filePath));
  let out = '';
  await new Promise((resolve) => {
    stream.on('data', (d) => (out += d.toString()));
    stream.on('end', resolve);
    stream.on('error', resolve);
  });
  return out.trim();
}

/**
 * Import an image tarball to MULTIPLE nodes in one request. The upload is
 * buffered to a temp file on the manager once, then fanned out to each node
 * (agent or local) concurrently. Returns per-node results.
 */
export async function imageImportMulti(nodeIds, req, res) {
  await requireManager();
  const ids = [...new Set((nodeIds || []).filter(Boolean))];
  if (ids.length === 0) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'nodeIds erforderlich' })); }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'swarmdash-imgimport-'));
  const tmp = path.join(dir, 'image.tar');
  try {
    await pipeline(req, createWriteStream(tmp));
    const results = await Promise.all(ids.map(async (nodeId) => {
      try {
        const output = await loadTarToNode(nodeId, tmp);
        return { nodeId, ok: true, output: (output || '').slice(0, 300) };
      } catch (e) {
        return { nodeId, ok: false, error: e.message };
      }
    }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ results }));
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
