/**
 * Container recreate helper — runs on whichever engine imports it (manager via
 * docker.js, or the node agent). Replaces a bind mount with a named volume on a
 * STOPPED standalone container by recreating it with the same config.
 */
import { docker } from './docker.js';
import { Writable } from 'node:stream';
import { ensureImage } from './ephemeral.js';

/* --------------------------- exec helper --------------------------- */

function collector(arr) {
  return new Writable({ write(chunk, _enc, cb) { arr.push(chunk); cb(); } });
}

/** Run a command inside a container and capture stdout/stderr/exit code. */
export async function execCapture(id, cmd, { stdin = null } = {}) {
  const c = docker.getContainer(id);
  const exec = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, AttachStdin: stdin != null, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: stdin != null });
  const outArr = []; const errArr = [];
  const done = new Promise((resolve, reject) => {
    docker.modem.demuxStream(stream, collector(outArr), collector(errArr));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  if (stdin != null) { stream.write(stdin); stream.end(); }
  await done;
  const info = await exec.inspect();
  return { stdout: Buffer.concat(outArr), stderr: Buffer.concat(errArr).toString('utf8'), exitCode: info.ExitCode };
}

/* --------------------------- processes ----------------------------- */

/** Running processes in a container (docker top / ps). */
export async function containerTop(id, psArgs = 'aux') {
  const data = await docker.getContainer(id).top({ ps_args: psArgs });
  return { titles: data.Titles || [], processes: data.Processes || [] };
}

/* ----------------------------- layers ------------------------------ */

/** Image layer history + totals for a given image reference. */
export async function imageHistory(ref) {
  let img = docker.getImage(ref);
  let hist; let info;
  try {
    [hist, info] = await Promise.all([img.history(), img.inspect().catch(() => null)]);
  } catch (e) {
    // Swarm pins images by digest, so a bare tag may not resolve via getImage().
    // Fall back to matching listImages (RepoTags/RepoDigests/Id) and use the Id.
    const images = await docker.listImages().catch(() => []);
    const bare = ref.replace(/^sha256:/, '');
    const match = images.find((im) =>
      (im.RepoTags || []).some((t) => t === ref || t.split('@')[0] === ref)
      || (im.RepoDigests || []).some((d) => d === ref || d.split('@')[1] === bare)
      || im.Id === ref || im.Id === `sha256:${bare}` || (im.Id || '').replace(/^sha256:/, '').startsWith(bare));
    if (!match) throw e;
    img = docker.getImage(match.Id);
    [hist, info] = await Promise.all([img.history(), img.inspect().catch(() => null)]);
  }
  const layers = (hist || []).map((h) => ({
    id: h.Id && h.Id !== '<missing>' ? h.Id : null,
    created: h.Created || null,
    createdBy: h.CreatedBy || '',
    size: h.Size || 0,
    comment: h.Comment || '',
    tags: h.Tags || [],
  }));
  return {
    ref,
    id: info?.Id ? info.Id.replace(/^sha256:/, '').slice(0, 12) : null,
    totalSize: info?.Size ?? layers.reduce((a, l) => a + l.size, 0),
    totalLayers: layers.length,
    layers,
  };
}

/* --------------------------- filesystem ---------------------------- */

const rwxToOctal = (perms) => {
  // perms like "rwxr-xr-x" (9 chars)
  let oct = '';
  for (let i = 0; i < 9; i += 3) {
    const seg = perms.slice(i, i + 3);
    oct += (seg[0] === 'r' ? 4 : 0) + (seg[1] === 'w' ? 2 : 0) + (seg[2] === 'x' || seg[2] === 's' || seg[2] === 't' ? 1 : 0);
  }
  return oct;
};

const normPath = (p) => {
  let s = String(p || '/').replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
};

/** List a directory inside a container (parses `ls -la`). */
export async function fsList(id, path) {
  const dir = normPath(path);
  const r = await execCapture(id, ['ls', '-la', dir]);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `Kann Verzeichnis nicht lesen: ${dir}`);
  const lines = r.stdout.toString('utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    if (/^total\s+\d+/i.test(line)) continue;
    // perms links owner group size  month day time/year  name[ -> target]
    const m = line.match(/^([bcdlps-][rwxsStT-]{9})[.+]?\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/);
    if (!m) continue;
    const permStr = m[1];
    const owner = m[2];
    const group = m[3];
    const size = Number(m[4]);
    const modified = m[5].trim();
    let name = m[6];
    let link = null;
    const arrow = name.indexOf(' -> ');
    if (arrow >= 0) { link = name.slice(arrow + 4); name = name.slice(0, arrow); }
    if (name === '.' || name === '..') continue;
    const t = permStr[0];
    const type = t === 'd' ? 'dir' : t === 'l' ? 'symlink' : 'file';
    entries.push({
      name, type,
      size: type === 'dir' ? null : size,
      perms: permStr.slice(1),
      octal: rwxToOctal(permStr.slice(1)),
      owner, group, modified, link,
    });
  }
  entries.sort((a, b) => (a.type === 'dir' && b.type !== 'dir' ? -1 : a.type !== 'dir' && b.type === 'dir' ? 1 : a.name.localeCompare(b.name)));
  return { path: dir, entries };
}

/** Read a file's content (capped) for download/preview. */
export async function fsRead(id, path, maxBytes = 1024 * 1024) {
  const file = normPath(path);
  const r = await execCapture(id, ['cat', file]);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `Kann Datei nicht lesen: ${file}`);
  const buf = r.stdout.length > maxBytes ? r.stdout.slice(0, maxBytes) : r.stdout;
  return { path: file, truncated: r.stdout.length > maxBytes, base64: buf.toString('base64') };
}

/** Filesystem mutation ops: mkdir | newfile | delete | write. */
export async function fsOp(id, op, path, { contentB64 } = {}) {
  const p = normPath(path);
  if (op === 'mkdir') {
    const r = await execCapture(id, ['mkdir', '-p', p]);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'mkdir fehlgeschlagen');
  } else if (op === 'newfile') {
    const r = await execCapture(id, ['touch', p]);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'Datei anlegen fehlgeschlagen');
  } else if (op === 'delete') {
    const r = await execCapture(id, ['rm', '-rf', p]);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'Löschen fehlgeschlagen');
  } else if (op === 'write') {
    const data = Buffer.from(contentB64 || '', 'base64');
    const r = await execCapture(id, ['sh', '-c', 'cat > "$0"', p], { stdin: data });
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'Schreiben fehlgeschlagen');
  } else {
    throw new Error(`Unbekannte Datei-Operation: ${op}`);
  }
  return { ok: true, path: p, op };
}

export async function containerState(id) {
  const info = await docker.getContainer(id).inspect();
  return {
    running: Boolean(info.State?.Running),
    state: info.State?.Status || null,
    name: (info.Name || '').replace(/^\//, ''),
  };
}

const SWARM_SVC_LABEL = 'com.docker.swarm.service.id';

/* ----------------------- volume filesystem ------------------------- */

/**
 * Run fn against a short-lived alpine helper that has the named volume mounted
 * at /vol, then remove it. Reuses the container fs helpers (execCapture based)
 * so listing/reading/writing inside a volume works like a container browse.
 */
async function withVolumeHelper(volume, fn) {
  const image = await ensureImage();
  const c = await docker.createContainer({
    Image: image,
    Cmd: ['sleep', '120'],
    Entrypoint: [''], // neutralize the dashboard image's ENTRYPOINT (node)
    HostConfig: { Binds: [`${volume}:/vol`], AutoRemove: false },
    Tty: false,
  });
  try {
    await c.start();
    return await fn(c.id);
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

const volPath = (p) => '/vol' + (p && p !== '/' ? (p.startsWith('/') ? p : '/' + p) : '');
const stripVol = (p) => (p || '').replace(/^\/vol/, '') || '/';

export async function volumeFsList(volume, p) {
  return withVolumeHelper(volume, async (cid) => {
    const r = await fsList(cid, volPath(p) || '/vol');
    return { ...r, path: stripVol(r.path) };
  });
}
export async function volumeFsRead(volume, p) {
  return withVolumeHelper(volume, async (cid) => {
    const r = await fsRead(cid, volPath(p));
    return { ...r, path: stripVol(r.path) };
  });
}
export async function volumeFsOp(volume, op, p, opts) {
  return withVolumeHelper(volume, async (cid) => {
    const r = await fsOp(cid, op, volPath(p), opts);
    return { ...r, path: stripVol(r.path) };
  });
}

/** Return the editable config of a standalone container (prefill for the edit form). */
export async function containerConfig(id) {
  const info = await docker.getContainer(id).inspect();
  const labels = info.Config?.Labels || {};
  const swarm = Boolean(labels[SWARM_SVC_LABEL] || labels['com.docker.swarm.service.name']);
  const bindings = info.HostConfig?.PortBindings || {};
  const ports = [];
  for (const [key, arr] of Object.entries(bindings)) {
    const [cport, proto = 'tcp'] = key.split('/');
    const list = Array.isArray(arr) && arr.length ? arr : [{}];
    for (const b of list) ports.push({ containerPort: cport, proto, hostPort: b.HostPort || '', hostIp: b.HostIp || '' });
  }
  const mounts = (info.Mounts || []).map((m) => ({
    type: m.Type || (m.Name ? 'volume' : 'bind'),
    source: (m.Type === 'volume' || m.Name) ? (m.Name || m.Source) : m.Source,
    target: m.Destination,
    readOnly: m.RW === false,
  }));
  const networks = Object.keys(info.NetworkSettings?.Networks || {});
  let availableNetworks = [];
  try {
    const nets = await docker.listNetworks();
    availableNetworks = nets.map((n) => n.Name).filter((n) => n && n !== 'host' && n !== 'none').sort();
  } catch { /* ignore */ }
  return {
    id: info.Id,
    name: (info.Name || '').replace(/^\//, ''),
    image: info.Config?.Image || '',
    env: info.Config?.Env || [],
    cmd: info.Config?.Cmd || [],
    entrypoint: info.Config?.Entrypoint || [],
    restartPolicy: info.HostConfig?.RestartPolicy?.Name || 'no',
    ports,
    mounts,
    networks,
    availableNetworks,
    running: Boolean(info.State?.Running),
    swarm,
  };
}

/**
 * Recreate a standalone container with an edited config (image, env, ports,
 * command, restart policy). Refuses swarm-managed containers. Preserves other
 * settings, mounts and network attachments; restarts it if it was running.
 */
export async function recreateContainer(id, patch = {}) {
  const c = docker.getContainer(id);
  const info = await c.inspect();
  const labels = info.Config?.Labels || {};
  if (labels[SWARM_SVC_LABEL] || labels['com.docker.swarm.service.name']) {
    throw new Error('Service-verwaltete Container können hier nicht bearbeitet werden');
  }
  const name = (info.Name || '').replace(/^\//, '');
  const wasRunning = Boolean(info.State?.Running);

  const config = structuredClone(info.Config || {});
  const hostConfig = structuredClone(info.HostConfig || {});

  if (typeof patch.image === 'string' && patch.image.trim()) config.Image = patch.image.trim();
  if (Array.isArray(patch.env)) config.Env = patch.env;
  if (Array.isArray(patch.cmd)) config.Cmd = patch.cmd.length ? patch.cmd : null;
  if (typeof patch.restartPolicy === 'string' && patch.restartPolicy) {
    hostConfig.RestartPolicy = {
      Name: patch.restartPolicy,
      MaximumRetryCount: patch.restartPolicy === 'on-failure' ? Number(patch.maxRetry || 0) : 0,
    };
  }
  if (Array.isArray(patch.ports)) {
    const exposed = { ...(config.ExposedPorts || {}) };
    const portBindings = {};
    for (const p of patch.ports) {
      const proto = (p.proto || 'tcp').toLowerCase();
      const cport = String(p.containerPort ?? '').trim();
      if (!cport) continue;
      const key = `${cport}/${proto}`;
      exposed[key] = {};
      if (p.hostPort !== undefined && String(p.hostPort).trim() !== '') {
        portBindings[key] = [{ HostIp: p.hostIp || '', HostPort: String(p.hostPort).trim() }];
      }
    }
    config.ExposedPorts = exposed;
    hostConfig.PortBindings = portBindings;
  }

  // Volumes / mounts: rebuild HostConfig.Mounts from the edited list and drop
  // the legacy Binds so there are no duplicate/conflicting mount definitions.
  if (Array.isArray(patch.mounts)) {
    hostConfig.Binds = undefined;
    hostConfig.Mounts = patch.mounts
      .filter((m) => m && m.source && m.target)
      .map((m) => ({
        Type: m.type === 'bind' ? 'bind' : 'volume',
        Source: String(m.source).trim(),
        Target: String(m.target).trim(),
        ReadOnly: Boolean(m.readOnly),
      }));
  }

  // Networks: choose the target set (edited or the original) and preserve
  // per-endpoint aliases (minus the stale short-id alias of the old container).
  const nets = info.NetworkSettings?.Networks || {};
  const shortId = String(info.Id || '').slice(0, 12);
  const targetNets = Array.isArray(patch.networks) ? patch.networks : Object.keys(nets);
  const endpointFor = (netName) => {
    const ep = nets[netName] || {};
    const cfg = {};
    const aliases = (ep.Aliases || []).filter((a) => a && a !== shortId);
    if (aliases.length) cfg.Aliases = aliases;
    if (ep.IPAMConfig) cfg.IPAMConfig = ep.IPAMConfig;
    return cfg;
  };

  const createOpts = { ...config, name, HostConfig: hostConfig };
  // Attach the first network at create time; connect the rest afterwards for
  // maximum engine compatibility (some versions reject multiple at create).
  const [firstNet, ...restNets] = targetNets;
  if (firstNet) createOpts.NetworkingConfig = { EndpointsConfig: { [firstNet]: endpointFor(firstNet) } };

  if (info.State?.Running) { try { await c.stop({ t: 5 }); } catch { /* already stopped */ } }
  await c.remove({ force: true });
  const created = await docker.createContainer(createOpts);
  for (const nn of restNets) {
    try { await docker.getNetwork(nn).connect({ Container: created.id, EndpointConfig: endpointFor(nn) }); } catch { /* best effort */ }
  }
  const started = wasRunning || Boolean(patch.start);
  if (started) await created.start();
  return { ok: true, newId: created.id, name, started };
}

/** Recreate a stopped container, swapping bind (source→target) for a named volume. */
export async function recreateWithVolume(id, source, target, volume) {
  const c = docker.getContainer(id);
  const info = await c.inspect();
  if (info.State?.Running) throw new Error('Container läuft noch — bitte zuerst stoppen');
  const name = (info.Name || '').replace(/^\//, '');
  const hostConfig = { ...(info.HostConfig || {}) };

  let replaced = false;
  // HostConfig.Binds entries look like "source:target[:opts]" (source is a named
  // volume when it has no leading slash) — swap the matching bind for the volume.
  const binds = Array.isArray(hostConfig.Binds) ? [...hostConfig.Binds] : [];
  const newBinds = binds.map((b) => {
    const i1 = b.indexOf(':');
    if (i1 < 0) return b;
    const bSource = b.slice(0, i1);
    const rest = b.slice(i1 + 1);
    const i2 = rest.indexOf(':');
    const bTarget = i2 >= 0 ? rest.slice(0, i2) : rest;
    const opts = i2 >= 0 ? rest.slice(i2) : ''; // keeps the leading ':'
    if (bSource === source && bTarget === target) { replaced = true; return `${volume}:${target}${opts}`; }
    return b;
  });

  // Also support the --mount style (HostConfig.Mounts with Type=bind).
  let mounts = Array.isArray(hostConfig.Mounts) ? [...hostConfig.Mounts] : [];
  if (!replaced && mounts.length) {
    mounts = mounts.map((m) => {
      if (m.Type === 'bind' && m.Source === source && m.Target === target) {
        replaced = true;
        return { Type: 'volume', Source: volume, Target: target, ReadOnly: Boolean(m.ReadOnly) };
      }
      return m;
    });
  }
  if (!replaced) throw new Error('Bind-Mount im Container nicht gefunden');
  hostConfig.Binds = newBinds;
  hostConfig.Mounts = mounts;

  // Preserve network attachments.
  const nets = info.NetworkSettings?.Networks || {};
  const EndpointsConfig = {};
  for (const [netName, ep] of Object.entries(nets)) {
    const cfg = {};
    if (ep.Aliases?.length) cfg.Aliases = ep.Aliases;
    if (ep.IPAMConfig) cfg.IPAMConfig = ep.IPAMConfig;
    EndpointsConfig[netName] = cfg;
  }

  const createOpts = { ...(info.Config || {}), name, HostConfig: hostConfig };
  if (Object.keys(EndpointsConfig).length) createOpts.NetworkingConfig = { EndpointsConfig };

  await c.remove({ force: true });
  const created = await docker.createContainer(createOpts);
  // The container was stopped before migration — leave it stopped for the user.
  return { ok: true, newId: created.id, name };
}
