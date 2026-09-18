import { Router } from 'express';
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { docker, requireManager } from '../docker.js';
import { loadStacks, saveStack, deleteStack, getStack } from '../stackstore.js';

const router = Router();
const NS_LABEL = 'com.docker.stack.namespace';
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Best-effort reconstruction of a compose file from a deployed stack's services. */
async function reconstructCompose(name) {
  const filters = { label: [`${NS_LABEL}=${name}`] };
  const [services, networks] = await Promise.all([
    docker.listServices({ filters }),
    docker.listNetworks({ filters }),
  ]);
  const strip = (s) => (s && s.startsWith(`${name}_`) ? s.slice(name.length + 1) : s);
  const netById = new Map(networks.map((n) => [n.Id, n.Name]));

  const compose = { version: '3.8', services: {} };
  const usedNetworks = new Set();
  const usedVolumes = new Set();

  for (const s of services) {
    const spec = s.Spec;
    const cs = spec.TaskTemplate?.ContainerSpec || {};
    const svc = { image: (cs.Image || '').split('@')[0] };

    if (cs.Command) svc.entrypoint = cs.Command;
    if (cs.Args) svc.command = cs.Args;
    if (cs.Env?.length) svc.environment = cs.Env;

    const ports = (spec.EndpointSpec?.Ports || s.Endpoint?.Ports || [])
      .filter((p) => p.PublishedPort)
      .map((p) => `${p.PublishedPort}:${p.TargetPort}${p.Protocol && p.Protocol !== 'tcp' ? '/' + p.Protocol : ''}`);
    if (ports.length) svc.ports = ports;

    const vols = [];
    for (const m of cs.Mounts || []) {
      if (m.Type === 'volume') {
        const vn = strip(m.Source);
        usedVolumes.add(vn);
        vols.push(`${vn}:${m.Target}${m.ReadOnly ? ':ro' : ''}`);
      } else if (m.Type === 'bind') {
        vols.push(`${m.Source}:${m.Target}${m.ReadOnly ? ':ro' : ''}`);
      }
    }
    if (vols.length) svc.volumes = vols;

    const deploy = {};
    if (spec.Mode?.Replicated) deploy.replicas = spec.Mode.Replicated.Replicas;
    else if (spec.Mode?.Global) deploy.mode = 'global';
    const userLabels = Object.fromEntries(
      Object.entries(spec.Labels || {}).filter(([k]) => !k.startsWith('com.docker.stack'))
    );
    if (Object.keys(userLabels).length) deploy.labels = userLabels;
    if (Object.keys(deploy).length) svc.deploy = deploy;

    const nets = (spec.TaskTemplate?.Networks || []).map((n) => strip(netById.get(n.Target) || n.Target));
    if (nets.length) { svc.networks = nets; nets.forEach((n) => usedNetworks.add(n)); }

    compose.services[strip(spec.Name)] = svc;
  }

  if (usedVolumes.size) { compose.volumes = {}; for (const v of usedVolumes) compose.volumes[v] = {}; }
  if (usedNetworks.size) { compose.networks = {}; for (const n of usedNetworks) compose.networks[n] = {}; }
  return yaml.dump(compose, { lineWidth: 120, noRefs: true });
}

/** Group swarm objects by their stack namespace label. */
router.get('/', async (req, res, next) => {
  try {
    await requireManager();
    const [services, tasks] = await Promise.all([
      docker.listServices(),
      docker.listTasks(),
    ]);
    const runningByService = new Map();
    for (const t of tasks) {
      if (t.Status?.State === 'running') {
        runningByService.set(t.ServiceID, (runningByService.get(t.ServiceID) || 0) + 1);
      }
    }
    const stacks = new Map();
    for (const s of services) {
      const ns = s.Spec?.Labels?.[NS_LABEL];
      if (!ns) continue;
      if (!stacks.has(ns)) stacks.set(ns, { name: ns, services: 0, tasksRunning: 0 });
      const rec = stacks.get(ns);
      rec.services += 1;
      rec.tasksRunning += runningByService.get(s.ID) || 0;
    }
    res.json([...stacks.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    next(err);
  }
});

/** Diff a proposed compose against the currently deployed stack (image/replicas/env/ports). */
router.post('/:name/diff', async (req, res, next) => {
  try {
    await requireManager();
    const { name } = req.params;
    const { compose } = req.body || {};
    if (!compose || typeof compose !== 'string') {
      return res.status(400).json({ error: 'compose (YAML-String) erforderlich' });
    }
    let doc;
    try { doc = yaml.load(compose); } catch (e) {
      return res.status(400).json({ error: `Ungültiges Compose-YAML: ${e.message}` });
    }
    const proposed = (doc && doc.services) || {};

    const filters = { label: [`${NS_LABEL}=${name}`] };
    const current = await docker.listServices({ filters });
    const strip = (s) => (s && s.startsWith(`${name}_`) ? s.slice(name.length + 1) : s);
    const curByName = new Map();
    for (const s of current) {
      const spec = s.Spec || {};
      const cs = spec.TaskTemplate?.ContainerSpec || {};
      const mode = spec.Mode || {};
      curByName.set(strip(spec.Name), {
        image: (cs.Image || '').split('@')[0],
        replicas: mode.Replicated ? (mode.Replicated.Replicas ?? null) : (mode.Global ? 'global' : null),
        env: (cs.Env || []).slice().sort(),
        ports: (spec.EndpointSpec?.Ports || s.Endpoint?.Ports || [])
          .filter((p) => p.PublishedPort)
          .map((p) => `${p.PublishedPort}:${p.TargetPort}${p.Protocol && p.Protocol !== 'tcp' ? '/' + p.Protocol : ''}`)
          .sort(),
      });
    }

    const normPorts = (arr) => (arr || []).map((p) => (typeof p === 'string' ? p : `${p.published || p.target}:${p.target}`)).sort();
    const normEnv = (env) => {
      if (Array.isArray(env)) return env.slice().sort();
      if (env && typeof env === 'object') return Object.entries(env).map(([k, v]) => `${k}=${v}`).sort();
      return [];
    };
    const replicasOf = (svc) => {
      if (svc.deploy?.mode === 'global') return 'global';
      const r = svc.deploy?.replicas;
      return r === undefined ? 1 : r;
    };

    const names = new Set([...curByName.keys(), ...Object.keys(proposed)]);
    const diffs = [];
    for (const n of [...names].sort()) {
      const cur = curByName.get(n);
      const pr = proposed[n];
      if (!cur) { diffs.push({ service: n, change: 'added', fields: [] }); continue; }
      if (!pr) { diffs.push({ service: n, change: 'removed', fields: [] }); continue; }
      const prImage = (pr.image || '').split('@')[0];
      const prReplicas = replicasOf(pr);
      const prEnv = normEnv(pr.environment);
      const prPorts = normPorts(pr.ports);
      const fields = [];
      if (prImage && prImage !== cur.image) fields.push({ field: 'image', from: cur.image, to: prImage });
      if (String(prReplicas) !== String(cur.replicas)) fields.push({ field: 'replicas', from: cur.replicas, to: prReplicas });
      if (JSON.stringify(prEnv) !== JSON.stringify(cur.env)) fields.push({ field: 'env', from: cur.env, to: prEnv });
      if (JSON.stringify(prPorts) !== JSON.stringify(cur.ports)) fields.push({ field: 'ports', from: cur.ports, to: prPorts });
      diffs.push({ service: n, change: fields.length ? 'changed' : 'unchanged', fields });
    }
    const summary = {
      added: diffs.filter((d) => d.change === 'added').length,
      removed: diffs.filter((d) => d.change === 'removed').length,
      changed: diffs.filter((d) => d.change === 'changed').length,
      unchanged: diffs.filter((d) => d.change === 'unchanged').length,
    };
    res.json({ name, deployed: current.length > 0, summary, diffs });
  } catch (err) {
    next(err);
  }
});

/** Deploy (create/update) a stack from a compose YAML string via the docker CLI. */
router.post('/deploy', async (req, res, next) => {
  let tmpFile;
  try {
    await requireManager();
    const { name, compose } = req.body;
    if (!name || !NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Ungültiger Stack-Name' });
    }
    if (!compose || typeof compose !== 'string') {
      return res.status(400).json({ error: 'compose (YAML-String) erforderlich' });
    }
    try {
      yaml.load(compose); // fail fast on malformed YAML
    } catch (e) {
      return res.status(400).json({ error: `Ungültiges Compose-YAML: ${e.message}` });
    }

    tmpFile = path.join(os.tmpdir(), `stack-${name}-${Date.now()}.yml`);
    await writeFile(tmpFile, compose, 'utf8');

    // Optionally persist the definition alongside deploying it.
    if (req.body.save) await saveStack(name, compose).catch(() => {});

    const args = [
      'stack',
      'deploy',
      '--detach=true',
      '--with-registry-auth',
      '-c',
      tmpFile,
      name,
    ];
    const child = spawn('docker', args, { env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => next(new Error(`docker CLI nicht verfügbar: ${e.message}`)));
    child.on('close', async (code) => {
      if (tmpFile) await unlink(tmpFile).catch(() => {});
      if (code === 0) {
        res.json({ ok: true, output: out.trim() });
      } else {
        res.status(500).json({ error: err.trim() || out.trim() || `Exit ${code}` });
      }
    });
  } catch (err) {
    if (tmpFile) await unlink(tmpFile).catch(() => {});
    next(err);
  }
});

/** Remove a stack: delete all swarm objects carrying the namespace label. */
router.delete('/:name', async (req, res, next) => {
  try {
    await requireManager();
    const { name } = req.params;
    if (!NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Ungültiger Stack-Name' });
    }
    const filters = { label: [`${NS_LABEL}=${name}`] };
    const [services, networks, secrets, configs] = await Promise.all([
      docker.listServices({ filters }),
      docker.listNetworks({ filters }),
      docker.listSecrets({ filters }),
      docker.listConfigs({ filters }),
    ]);

    const removed = { services: 0, networks: 0, secrets: 0, configs: 0 };
    for (const s of services) {
      await docker.getService(s.ID).remove().catch(() => {});
      removed.services += 1;
    }
    for (const n of networks) {
      await docker.getNetwork(n.Id).remove().catch(() => {});
      removed.networks += 1;
    }
    for (const s of secrets) {
      await docker.getSecret(s.ID).remove().catch(() => {});
      removed.secrets += 1;
    }
    for (const c of configs) {
      await docker.getConfig(c.ID).remove().catch(() => {});
      removed.configs += 1;
    }

    if (Object.values(removed).every((v) => v === 0)) {
      return res.status(404).json({ error: `Stack "${name}" nicht gefunden` });
    }
    res.json({ ok: true, removed });
  } catch (err) {
    next(err);
  }
});

/* ---- Saved stack definitions (compose stored in DATA_DIR) ---- */

router.get('/saved', async (req, res, next) => {
  try {
    res.json(await loadStacks());
  } catch (err) {
    next(err);
  }
});

router.put('/saved', async (req, res, next) => {
  try {
    const { name, compose } = req.body || {};
    if (!name || !NAME_RE.test(name)) return res.status(400).json({ error: 'Ungültiger Stack-Name' });
    if (!compose || typeof compose !== 'string') return res.status(400).json({ error: 'compose erforderlich' });
    try { yaml.load(compose); } catch (e) { return res.status(400).json({ error: `Ungültiges YAML: ${e.message}` }); }
    res.json(await saveStack(name, compose));
  } catch (err) {
    next(err);
  }
});

router.delete('/saved/:name', async (req, res, next) => {
  try {
    if (!NAME_RE.test(req.params.name)) return res.status(400).json({ error: 'Ungültiger Name' });
    await deleteStack(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/saved/:name/export', async (req, res, next) => {
  try {
    const s = await getStack(req.params.name);
    if (!s) return res.status(404).json({ error: 'Stack nicht gefunden' });
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.yml"`);
    res.send(s.compose);
  } catch (err) {
    next(err);
  }
});

/** Compose for editing a deployed stack: prefer a saved definition, else reconstruct. */
router.get('/:name/compose', async (req, res, next) => {
  try {
    await requireManager();
    const { name } = req.params;
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Ungültiger Name' });
    const saved = await getStack(name);
    if (saved) return res.json({ compose: saved.compose, source: 'saved' });
    res.json({ compose: await reconstructCompose(name), source: 'reconstructed' });
  } catch (err) {
    next(err);
  }
});

/** Detail: services of a stack, where their tasks run, and defined-but-not-deployed services. */
router.get('/:name/detail', async (req, res, next) => {
  try {
    await requireManager();
    const { name } = req.params;
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Ungültiger Name' });
    const filters = { label: [`${NS_LABEL}=${name}`] };
    const [services, tasks, nodes] = await Promise.all([
      docker.listServices({ filters }),
      docker.listTasks(),
      docker.listNodes(),
    ]);
    const nodeMap = new Map(nodes.map((n) => [n.ID, {
      hostname: n.Description?.Hostname, role: n.Spec?.Role, leader: n.ManagerStatus?.Leader ?? false,
    }]));
    const runningBySvc = new Map();
    for (const t of tasks) {
      if (t.Status?.State !== 'running') continue;
      if (!runningBySvc.has(t.ServiceID)) runningBySvc.set(t.ServiceID, []);
      runningBySvc.get(t.ServiceID).push(t);
    }

    const strip = (s) => (s.startsWith(`${name}_`) ? s.slice(name.length + 1) : s);
    const deployed = new Set();
    const svcList = services.map((s) => {
      const shortName = strip(s.Spec.Name);
      deployed.add(shortName);
      const mode = s.Spec.Mode || {};
      const desired = mode.Replicated ? mode.Replicated.Replicas : mode.Global ? null : 0;
      const placement = (runningBySvc.get(s.ID) || []).map((t) => ({
        node: nodeMap.get(t.NodeID) || { hostname: t.NodeID, role: '?' },
        slot: t.Slot ?? null,
        state: t.Status?.State,
      })).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
      const running = placement.length;
      let status = 'running';
      if (running === 0) status = 'inaktiv';
      else if (desired != null && running < desired) status = 'degraded';
      return {
        name: shortName,
        fullName: s.Spec.Name,
        image: (s.Spec.TaskTemplate?.ContainerSpec?.Image || '').split('@')[0],
        mode: mode.Replicated ? 'replicated' : mode.Global ? 'global' : 'other',
        desired,
        running,
        status,
        placement,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    // Services defined in a saved compose but not currently deployed.
    let definedOnly = [];
    const saved = await getStack(name);
    if (saved) {
      try {
        const doc = yaml.load(saved.compose);
        const defined = Object.keys(doc?.services || {});
        definedOnly = defined.filter((k) => !deployed.has(k));
      } catch { /* ignore parse errors */ }
    }
    res.json({ name, services: svcList, definedOnly });
  } catch (err) {
    next(err);
  }
});

export default router;
