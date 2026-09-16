import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Build a dockerode client that honors the standard Docker environment
 * variables, falling back to the local socket / named pipe.
 *
 *  - DOCKER_HOST      e.g. tcp://10.0.0.5:2375  or  unix:///var/run/docker.sock
 *  - DOCKER_TLS_VERIFY + DOCKER_CERT_PATH   for a TLS-protected daemon (2376)
 *  - otherwise: //./pipe/docker_engine (Windows) or /var/run/docker.sock (POSIX)
 */
function buildDocker() {
  const host = process.env.DOCKER_HOST;

  if (host && /^tcp:\/\//i.test(host)) {
    const url = new URL(host);
    const useTls =
      process.env.DOCKER_TLS_VERIFY === '1' ||
      process.env.DOCKER_TLS_VERIFY === 'true' ||
      url.port === '2376';

    const opts = {
      host: url.hostname,
      port: url.port ? Number(url.port) : useTls ? 2376 : 2375,
      protocol: useTls ? 'https' : 'http',
    };

    const certPath = process.env.DOCKER_CERT_PATH;
    if (useTls && certPath) {
      opts.ca = fs.readFileSync(path.join(certPath, 'ca.pem'));
      opts.cert = fs.readFileSync(path.join(certPath, 'cert.pem'));
      opts.key = fs.readFileSync(path.join(certPath, 'key.pem'));
    }
    return new Docker(opts);
  }

  if (host && /^unix:\/\//i.test(host)) {
    return new Docker({ socketPath: host.replace(/^unix:\/\//i, '') });
  }

  if (host && /^npipe:\/\//i.test(host)) {
    return new Docker({ socketPath: host.replace(/^npipe:\/\//i, '') });
  }

  // Sensible platform default.
  const socketPath =
    process.platform === 'win32'
      ? '//./pipe/docker_engine'
      : '/var/run/docker.sock';
  return new Docker({ socketPath });
}

export const docker = buildDocker();

/** Throws a clean error if the daemon we point at is not a swarm manager. */
export async function requireManager() {
  const info = await docker.info();
  if (!info.Swarm || info.Swarm.LocalNodeState !== 'active') {
    const err = new Error(
      'Der verbundene Docker-Daemon ist nicht Teil eines aktiven Swarm.'
    );
    err.status = 409;
    throw err;
  }
  if (!info.Swarm.ControlAvailable) {
    const err = new Error(
      'Der verbundene Node ist kein Swarm-Manager. Bitte an einen Manager-Node anbinden.'
    );
    err.status = 409;
    throw err;
  }
  return info;
}

/** Small helper to describe the current swarm/cluster in one payload. */
export async function clusterInfo() {
  const info = await docker.info();
  const swarm = info.Swarm || {};
  const manager = swarm.ControlAvailable === true;

  const payload = {
    dockerVersion: info.ServerVersion,
    os: `${info.OperatingSystem || ''} (${info.OSType}/${info.Architecture})`,
    hostname: info.Name,
    swarm: {
      state: swarm.LocalNodeState || 'inactive',
      nodeId: swarm.NodeID || null,
      isManager: manager,
      managers: swarm.Managers ?? null,
      nodes: swarm.Nodes ?? null,
    },
    resources: {
      containers: info.Containers,
      containersRunning: info.ContainersRunning,
      containersPaused: info.ContainersPaused,
      containersStopped: info.ContainersStopped,
      images: info.Images,
      ncpu: info.NCPU,
      memTotal: info.MemTotal,
    },
  };

  // If we are a manager, enrich with live service/task/stack counts.
  if (manager) {
    const [services, tasks, nodes] = await Promise.all([
      docker.listServices(),
      docker.listTasks(),
      docker.listNodes(),
    ]);
    const stacks = new Set();
    for (const s of services) {
      const ns = s.Spec?.Labels?.['com.docker.stack.namespace'];
      if (ns) stacks.add(ns);
    }
    payload.counts = {
      services: services.length,
      tasks: tasks.length,
      runningTasks: tasks.filter((t) => t.Status?.State === 'running').length,
      nodes: nodes.length,
      readyNodes: nodes.filter((n) => n.Status?.State === 'ready').length,
      stacks: stacks.size,
    };
  }

  return payload;
}
