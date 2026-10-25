import { Router } from 'express';
import { docker, requireManager } from '../docker.js';
import { nodesWithInterfaces, createNetworkFromSpec, describeNetwork, replaceNetwork, servicesUsing, nodeConfigs, deleteNetworkFully } from '../networkops.js';
import { listVolumes, volumeUsage, volumeRemove, volumeCreate, volumeRename, volumeDuplicate, volumeExport, volumeImport, listBindMounts, migrateContainer, migrateService, migrationPreflight, volumeFsListOnNode, volumeFsReadOnNode, volumeFsOpOnNode } from '../cluster.js';

const router = Router();

router.get('/networks', async (req, res, next) => {
  try {
    await requireManager();
    const nets = await docker.listNetworks();
    // A swarm macvlan/ipvlan network reports IPv6 via its config-only network.
    const cfgV6 = new Map(nets.filter((n) => n.ConfigOnly).map((n) => [n.Name, !!n.EnableIPv6]));
    res.json(
      nets.map((n) => ({
        id: n.Id,
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        internal: n.Internal,
        attachable: n.Attachable,
        ingress: n.Ingress || false,
        ipv6: n.EnableIPv6 || cfgV6.get(n.ConfigFrom?.Network) || false,
        configOnly: n.ConfigOnly || false,
        configFrom: n.ConfigFrom?.Network || null,
        managed: n.Labels?.['swarmdash.managed'] === 'true' || (!!n.ConfigFrom?.Network && n.ConfigFrom.Network === `${n.Name}-cfg`),
        stack: n.Labels?.['com.docker.stack.namespace'] || null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

/** Swarm nodes with their physical interfaces (parent picker + LAN hints). */
router.get('/networks/nodes', async (req, res, next) => {
  try { res.json(await nodesWithInterfaces()); } catch (err) { next(err); }
});

/** Create a network (overlay / macvlan / ipvlan). */
router.post('/networks', async (req, res) => {
  try { res.status(201).json(await createNetworkFromSpec(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/** Editable definition of an existing network. */
router.get('/networks/:id/spec', async (req, res, next) => {
  try { res.json(await describeNetwork(req.params.id)); } catch (err) { next(err); }
});

/** Edit = replace an unused network with a new definition (rollback on failure). */
router.put('/networks/:id', async (req, res) => {
  try { res.json(await replaceNetwork(req.params.id, req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/** Which swarm services and (cluster-wide) containers use a given network. */
router.get('/networks/:id/usage', async (req, res, next) => {
  try {
    await requireManager();
    const netInfo = await docker.getNetwork(req.params.id).inspect();
    const netId = netInfo.Id;
    const usingServices = await servicesUsing(netId);

    // Containers attached (from the network's own container map).
    const containers = [];
    for (const [cid, c] of Object.entries(netInfo.Containers || {})) {
      if (cid.startsWith('lb-')) continue;
      containers.push({ id: cid, name: c.Name });
    }

    const removable = usingServices.length === 0 && containers.length === 0 && !netInfo.Ingress
      && !(['host', 'bridge', 'none'].includes(netInfo.Name) && ['host', 'bridge', 'null'].includes(netInfo.Driver));
    const ipam = (netInfo.IPAM?.Config || []).map((c) => ({ subnet: c.Subnet || null, gateway: c.Gateway || null, ipRange: c.IPRange || null }));
    const cfgName = netInfo.ConfigFrom?.Network || null;
    const cfgs = cfgName ? await nodeConfigs(cfgName) : [];
    res.json({
      id: netId,
      name: netInfo.Name,
      driver: netInfo.Driver,
      scope: netInfo.Scope,
      ingress: netInfo.Ingress || false,
      attachable: netInfo.Attachable || false,
      internal: netInfo.Internal || false,
      ipv6: netInfo.EnableIPv6 || cfgs.some((c) => c.ipv6) || false,
      configOnly: netInfo.ConfigOnly || false,
      configFrom: cfgName,
      managed: netInfo.Labels?.['swarmdash.managed'] === 'true' || (!!cfgName && cfgName === `${netInfo.Name}-cfg`),
      options: netInfo.Options || {},
      nodeConfigs: cfgs,
      ipam,
      services: usingServices,
      containers,
      removable,
      reason: netInfo.Ingress ? 'Ingress-Netzwerk' : (!removable ? 'Netzwerk wird verwendet' : null),
    });
  } catch (err) {
    next(err);
  }
});

/** Delete a network (guarded: must be unused and not ingress); also removes per-node config-only halves. */
router.delete('/networks/:id', async (req, res) => {
  try { res.json(await deleteNetworkFully(req.params.id)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.get('/binds', async (req, res, next) => {
  try {
    res.json(await listBindMounts());
  } catch (err) { next(err); }
});
// Disk pre-check for a bindÃ¢â€ â€™volume migration (does the data node have room?).
router.post('/migrate/preflight', async (req, res, next) => {
  try {
    const { kind, nodeId, source } = req.body || {};
    res.json(await migrationPreflight({ kind, nodeId, source }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/migrate', async (req, res, next) => {
  const { kind, ...rest } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
  try {
    const cbs = {
      onPhase: (phase) => send({ type: 'phase', phase }),
      onSize: (total) => send({ type: 'size', total }),
      onBytes: (bytes) => send({ type: 'progress', bytes }),
    };
    let result;
    if (kind === 'container') result = await migrateContainer({ ...rest, ...cbs });
    else if (kind === 'service') result = await migrateService({ ...rest, ...cbs });
    else throw new Error('Unbekannter Migrationstyp');
    send({ type: 'done', result });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});
router.get('/volumes', async (req, res, next) => {
  try {
    res.json(await listVolumes());
  } catch (err) {
    next(err);
  }
});
router.get('/volumes/usage', async (req, res, next) => {
  try {
    const { nodeId, name } = req.query;
    if (!name) return res.status(400).json({ error: 'name erforderlich' });
    res.json(await volumeUsage(nodeId, name));
  } catch (err) { next(err); }
});
router.post('/volumes/action', async (req, res, next) => {
  try {
    const { nodeId, name, action, force } = req.body || {};
    if (action !== 'remove') return res.status(400).json({ error: 'Unbekannte Aktion' });
    res.json(await volumeRemove(nodeId, name, force));
  } catch (err) { next(err); }
});
router.post('/volumes/bulk-action', async (req, res, next) => {
  try {
    const { action, force, items } = req.body || {};
    if (action !== 'remove') return res.status(400).json({ error: 'Unbekannte Aktion' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items erforderlich' });
    const results = [];
    for (const it of items) {
      const name = it?.name;
      const nodeId = it?.nodeId ?? null;
      if (!name) { results.push({ name: name || '?', nodeId, ok: false, error: 'name fehlt' }); continue; }
      try {
        await volumeRemove(nodeId, name, !!force);
        results.push({ name, nodeId, ok: true });
      } catch (e) {
        results.push({ name, nodeId, ok: false, error: e.message });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    res.json({ ok, failed: results.length - ok, total: results.length, results });
  } catch (err) { next(err); }
});
router.post('/volumes/create', async (req, res, next) => {
  try {
    const { nodeId, name, driver, labels, driverOpts } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name erforderlich' });
    res.json(await volumeCreate(nodeId, { name, driver, labels, driverOpts }));
  } catch (err) { next(err); }
});
router.post('/volumes/duplicate', async (req, res, next) => {
  const { srcNodeId, name, dstNodeId, newName } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
  try {
    const result = await volumeDuplicate({
      srcNodeId, name, dstNodeId, newName,
      onSize: (total) => send({ type: 'size', total }),
      onBytes: (bytes) => send({ type: 'progress', bytes }),
    });
    send({ type: 'done', result });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});
router.post('/volumes/rename', async (req, res, next) => {
  const { nodeId, name, newName } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
  try {
    const result = await volumeRename(nodeId, name, newName, {
      onSize: (total) => send({ type: 'size', total }),
      onBytes: (bytes) => send({ type: 'progress', bytes }),
    });
    send({ type: 'done', result });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

/* --- volume content export (download tar) / import (upload tar) --- */
router.get('/volumes/export', async (req, res, next) => {
  try {
    const { nodeId, name } = req.query;
    if (!name) return res.status(400).json({ error: 'name erforderlich' });
    const stream = await volumeExport(nodeId, name);
    const fn = String(name).replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="${fn}.tar"`);
    stream.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: e.message }); else res.destroy(e); });
    stream.pipe(res);
  } catch (err) { next(err); }
});
router.post('/volumes/import', async (req, res, next) => {
  try {
    const { nodeId, name } = req.query;
    if (!name) return res.status(400).json({ error: 'name erforderlich' });
    // Raw tar arrives as the request body stream (Content-Type application/x-tar,
    // so express.json does not consume it).
    const result = await volumeImport(nodeId, name, req);
    res.json(result);
  } catch (err) { next(err); }
});
/* --- volume file browser (exec into a helper that mounts the volume) --- */
router.get('/volumes/fs/list', async (req, res, next) => {
  try {
    const { nodeId, volume, path } = req.query;
    if (!volume) return res.status(400).json({ error: 'volume erforderlich' });
    res.json(await volumeFsListOnNode(nodeId, volume, path || '/'));
  } catch (err) { next(err); }
});
router.get('/volumes/fs/read', async (req, res, next) => {
  try {
    const { nodeId, volume, path } = req.query;
    if (!volume || !path) return res.status(400).json({ error: 'volume und path erforderlich' });
    res.json(await volumeFsReadOnNode(nodeId, volume, path));
  } catch (err) { next(err); }
});
router.post('/volumes/fs/op', async (req, res, next) => {
  try {
    const { nodeId, volume, op, path, contentB64 } = req.body || {};
    if (!volume || !op || !path) return res.status(400).json({ error: 'volume, op, path erforderlich' });
    res.json(await volumeFsOpOnNode(nodeId, volume, op, path, contentB64));
  } catch (err) { next(err); }
});

router.get('/secrets', async (req, res, next) => {
  try {
    await requireManager();
    const secrets = await docker.listSecrets();
    res.json(
      secrets.map((s) => ({
        id: s.ID,
        name: s.Spec?.Name,
        createdAt: s.CreatedAt,
        stack: s.Spec?.Labels?.['com.docker.stack.namespace'] || null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// Create a new secret. Body: { name, dataB64 | data, labels }.
// Note: a secret value can never be read back Ã¢â‚¬â€ this only writes it.
router.post('/secrets', async (req, res, next) => {
  try {
    await requireManager();
    const { name, dataB64, data, labels } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name erforderlich' });
    const b64 = dataB64 != null ? dataB64 : Buffer.from(String(data ?? ''), 'utf8').toString('base64');
    if (!b64) return res.status(400).json({ error: 'Wert erforderlich' });
    const created = await docker.createSecret({ Name: name, Data: b64, Labels: labels || {} });
    res.json({ ok: true, id: created.id || created.ID || null });
  } catch (err) {
    const msg = /already exists|name conflicts/i.test(err.message || '') ? 'Ein Secret mit diesem Namen existiert bereits' : err.message;
    res.status(400).json({ error: msg });
  }
});

// Delete a secret (fails if still referenced by a service).
router.delete('/secrets/:id', async (req, res, next) => {
  try {
    await requireManager();
    await docker.getSecret(req.params.id).remove();
    res.json({ ok: true });
  } catch (err) {
    const msg = /in use/i.test(err.message || '') ? 'Secret wird noch von einem Service verwendet' : err.message;
    res.status(409).json({ error: msg });
  }
});

router.get('/configs', async (req, res, next) => {
  try {
    await requireManager();
    const configs = await docker.listConfigs();
    res.json(
      configs.map((c) => ({
        id: c.ID,
        name: c.Spec?.Name,
        createdAt: c.CreatedAt,
        size: c.Spec?.Data ? Buffer.from(c.Spec.Data, 'base64').length : null,
        stack: c.Spec?.Labels?.['com.docker.stack.namespace'] || null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// Config detail incl. content (base64 + text preview when printable).
router.get('/configs/:id', async (req, res, next) => {
  try {
    await requireManager();
    const info = await docker.getConfig(req.params.id).inspect();
    const dataB64 = info.Spec?.Data || '';
    const buf = Buffer.from(dataB64, 'base64');
    const printable = buf.length === 0 || !buf.slice(0, 4096).includes(0);
    res.json({
      id: info.ID,
      name: info.Spec?.Name,
      createdAt: info.CreatedAt,
      updatedAt: info.UpdatedAt,
      size: buf.length,
      labels: info.Spec?.Labels || {},
      stack: info.Spec?.Labels?.['com.docker.stack.namespace'] || null,
      dataB64,
      text: printable ? buf.toString('utf8') : null,
      binary: !printable,
    });
  } catch (err) {
    next(err);
  }
});

// Download a config's raw content as a file.
router.get('/configs/:id/export', async (req, res, next) => {
  try {
    await requireManager();
    const info = await docker.getConfig(req.params.id).inspect();
    const buf = Buffer.from(info.Spec?.Data || '', 'base64');
    const name = (info.Spec?.Name || 'config').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.end(buf);
  } catch (err) {
    next(err);
  }
});

// Create a new config (add/import). Body: { name, dataB64 | data, labels }.
router.post('/configs', async (req, res, next) => {
  try {
    await requireManager();
    const { name, dataB64, data, labels } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name erforderlich' });
    const b64 = dataB64 != null ? dataB64 : Buffer.from(String(data ?? ''), 'utf8').toString('base64');
    const created = await docker.createConfig({ Name: name, Data: b64, Labels: labels || {} });
    res.json({ ok: true, id: created.id || created.ID || null });
  } catch (err) {
    const msg = /already exists|name conflicts/i.test(err.message || '') ? 'Ein Config mit diesem Namen existiert bereits' : err.message;
    res.status(400).json({ error: msg });
  }
});

// Delete a config (fails if still referenced by a service).
router.delete('/configs/:id', async (req, res, next) => {
  try {
    await requireManager();
    await docker.getConfig(req.params.id).remove();
    res.json({ ok: true });
  } catch (err) {
    const msg = /in use/i.test(err.message || '') ? 'Config wird noch von einem Service verwendet' : err.message;
    res.status(409).json({ error: msg });
  }
});

export default router;
