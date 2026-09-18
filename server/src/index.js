import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';

import { docker, requireManager } from './docker.js';
import infoRouter from './routes/info.js';
import nodesRouter from './routes/nodes.js';
import servicesRouter from './routes/services.js';
import stacksRouter from './routes/stacks.js';
import tasksRouter from './routes/tasks.js';
import miscRouter from './routes/misc.js';
import settingsRouter from './routes/settings.js';
import backupRouter from './routes/backup.js';
import proxyRouter from './routes/proxy.js';
import clusterRouter from './routes/cluster.js';
import systemRouter from './routes/system.js';
import authRouter from './routes/auth.js';
import monitoringRouter from './routes/monitoring.js';
import registryRouter from './routes/registry.js';
import gitRouter from './routes/git.js';
import securityRouter from './routes/security.js';
import pkiRouter from './routes/pki.js';
import builderRouter from './routes/builder.js';
import auditRouter from './routes/audit.js';
import endpointsRouter from './routes/endpoints.js';
import { auditMiddleware } from './audit.js';
import { applySchedule } from './backup.js';
import { applyMonitoring } from './monitoring.js';
import { startMetricsSampler } from './metricshistory.js';
import { resolveRunningContainer } from './serviceops.js';
import { agentBaseForNode } from './metrics.js';
import { authGuard, isEnabled, verifyToken } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json({ limit: '2mb' }));

// --- API ---
const api = express.Router();
api.get('/health', (req, res) => res.json({ ok: true }));
api.use('/auth', authRouter);
api.use(authGuard()); // everything below requires auth when enabled
api.use(auditMiddleware()); // record mutating requests (after auth so actor is known)
api.use('/info', infoRouter);
api.use('/nodes', nodesRouter);
api.use('/services', servicesRouter);
api.use('/stacks', stacksRouter);
api.use('/tasks', tasksRouter);
api.use('/settings', settingsRouter);
api.use('/backup', backupRouter);
api.use('/proxy', proxyRouter);
api.use('/system', systemRouter);
api.use('/monitoring', monitoringRouter);
api.use('/registries', registryRouter);
api.use('/git', gitRouter);
api.use('/security', securityRouter);
api.use('/pki', pkiRouter);
api.use('/builder', builderRouter);
api.use('/audit', auditRouter);
api.use('/endpoints', endpointsRouter);
api.use('/', clusterRouter); // /containers /images
api.use('/', miscRouter); // /networks /volumes /secrets /configs
app.use('/api', api);

// --- Static client (built with Vite) ---
const clientDir = path.resolve(__dirname, '../../client/dist');
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

// --- Error handler ---
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Interner Fehler' });
});

const server = http.createServer(app);

// --- WebSocket servers (manual upgrade routing for /ws/logs and /ws/exec) ---
const wssLogs = new WebSocketServer({ noServer: true });
const wssExec = new WebSocketServer({ noServer: true });
const wssEvents = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  if (pathname !== '/ws/logs' && pathname !== '/ws/exec' && pathname !== '/ws/events') {
    return socket.destroy();
  }
  // Enforce auth for websockets when enabled (token via query param).
  if (await isEnabled()) {
    const user = await verifyToken(url.searchParams.get('token'));
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
  }
  if (pathname === '/ws/logs') {
    wssLogs.handleUpgrade(req, socket, head, (ws) => wssLogs.emit('connection', ws, req));
  } else if (pathname === '/ws/events') {
    wssEvents.handleUpgrade(req, socket, head, (ws) => wssEvents.emit('connection', ws, req));
  } else {
    wssExec.handleUpgrade(req, socket, head, (ws) => wssExec.emit('connection', ws, req));
  }
});

// Live Docker events feed (container/image/volume/network/service/node actions).
wssEvents.on('connection', async (ws) => {
  let eventStream;
  try {
    eventStream = await docker.getEvents();
    let buf = '';
    eventStream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'event',
              evType: ev.Type,
              action: ev.Action,
              actor: ev.Actor?.Attributes?.name || ev.Actor?.ID || null,
              image: ev.Actor?.Attributes?.image || null,
              node: ev.Actor?.Attributes?.['node.hostname'] || null,
              scope: ev.scope || null,
              time: (ev.time ? ev.time * 1000 : Date.now()),
              attributes: ev.Actor?.Attributes || {},
            }));
          }
        } catch { /* skip malformed line */ }
      }
    });
    eventStream.on('error', (e) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: e.message }));
    });
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: e.message }));
    return ws.close();
  }
  ws.on('close', () => { if (eventStream && typeof eventStream.destroy === 'function') eventStream.destroy(); });
});

// Live service logs.
wssLogs.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const serviceId = url.searchParams.get('service');
  const tail = url.searchParams.get('tail') || '200';

  if (!serviceId) {
    ws.send(JSON.stringify({ type: 'error', message: 'service-Parameter fehlt' }));
    return ws.close();
  }

  let logStream;
  try {
    await requireManager();
    const svc = docker.getService(serviceId);
    logStream = await svc.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: true,
      tail,
    });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(logStream, stdout, stderr);

    const forward = (stream, channel) =>
      stream.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'log', channel, line: chunk.toString('utf8') }));
        }
      });
    forward(stdout, 'stdout');
    forward(stderr, 'stderr');

    logStream.on('end', () => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'end' }));
    });
    logStream.on('error', (e) => {
      if (ws.readyState === ws.OPEN)
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
    });
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: e.message }));
    return ws.close();
  }

  ws.on('close', () => {
    if (logStream && typeof logStream.destroy === 'function') logStream.destroy();
  });
});

// Interactive console: docker exec into the service's running container.
wssExec.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const serviceId = url.searchParams.get('service');
  const shell = url.searchParams.get('shell') || '/bin/sh';
  const forceAgent = url.searchParams.get('via') === 'agent';

  const notify = (type, message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ __ctl: type, message }));
  };

  let execStream;
  let upstream;
  try {
    const { containerId, local, node, nodeId } = await resolveRunningContainer(serviceId);

    // --- Remote (or forced): broker through the target node's agent ---
    if (!local || forceAgent) {
      const base = await agentBaseForNode(nodeId, node);
      if (!base) {
        notify('error', `Kein erreichbarer Node-Agent auf "${node}". Konsole erfordert den Agenten auf diesem Node.`);
        return ws.close();
      }
      const wsUrl =
        base.replace(/^http/, 'ws') +
        `/exec?container=${encodeURIComponent(containerId)}&shell=${encodeURIComponent(shell)}`;
      upstream = new WebSocket(wsUrl);
      upstream.on('message', (d) => { if (ws.readyState === ws.OPEN) ws.send(d.toString()); });
      upstream.on('close', () => { if (ws.readyState === ws.OPEN) ws.close(); });
      upstream.on('error', (e) => { notify('error', `Agent-Verbindung: ${e.message}`); if (ws.readyState === ws.OPEN) ws.close(); });
      ws.on('message', (raw) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(raw.toString()); });
      ws.on('close', () => { if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close(); });
      return;
    }

    // --- Local: exec directly via the manager engine ---
    const container = docker.getContainer(containerId);
    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: [shell],
      Env: ['TERM=xterm-256color'],
    });
    execStream = await exec.start({ hijack: true, stdin: true, Tty: true });
    notify('ready', `Verbunden mit ${containerId.slice(0, 12)} (${shell})`);

    execStream.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk.toString('utf8'));
    });
    execStream.on('end', () => notify('end'));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input') execStream.write(msg.data);
      else if (msg.type === 'resize') exec.resize({ h: msg.rows, w: msg.cols }).catch(() => {});
    });
  } catch (e) {
    notify('error', e.message);
    return ws.close();
  }

  ws.on('close', () => {
    if (execStream && typeof execStream.destroy === 'function') execStream.destroy();
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close();
  });
});

server.listen(PORT, () => {
  console.log(`Swarm Dashboard läuft auf http://localhost:${PORT}`);
  console.log(`Docker-Endpoint: ${process.env.DOCKER_HOST || 'lokaler Socket/Pipe'}`);
  applySchedule().catch((e) => console.error('Scheduler-Init fehlgeschlagen:', e.message));
  applyMonitoring().catch((e) => console.error('Monitoring-Init fehlgeschlagen:', e.message));
  try { startMetricsSampler(); } catch (e) { console.error('Metrik-Sampler-Init fehlgeschlagen:', e.message); }
});
