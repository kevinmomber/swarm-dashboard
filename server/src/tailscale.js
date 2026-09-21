/**
 * Tailscale + DockTail managed stack.
 *
 * Runs `tailscaled` (Tailscale sidecar) and DockTail together as one Swarm stack
 * (`swarmdash-tailscale`), pinned to the manager node next to Traefik. DockTail
 * watches the Docker socket and advertises labeled containers as native Tailscale
 * Services via the sidecar's tailscaled.
 *
 * A-verfeinert model: DockTail publishes ONLY Traefik's dedicated `tailnet`
 * entrypoint (labels are attached to the Traefik service by proxy.js). Individual
 * apps opt in at the Traefik layer (per-service `-tailnet` path routers), so only
 * explicitly enabled services are reachable over the tailnet.
 *
 * Secrets (TS_AUTHKEY, OAuth client secret) come from settings (server-side only)
 * and are injected as Swarm secrets, never written to the compose file in clear.
 */
import { docker, requireManager } from './docker.js';
import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSettings } from './settings.js';
import { deployProxyStack, proxyStackStatus } from './proxy.js';

export const TS_STACK = 'swarmdash-tailscale';
const STATE_VOLUME = 'swarmdash_tailscale_state';
const SOCKET_VOLUME = 'swarmdash_tailscale_socket';

/** Normalized tailscale config with defaults. */
export function tsConfig(settings) {
  const t = settings.tailscale || {};
  return {
    enable: Boolean(t.enable),
    image: t.image || 'tailscale/tailscale:latest',
    docktailImage: t.docktailImage || 'ghcr.io/marvinvr/docktail:latest',
    hostname: (t.hostname || 'swarmdash').toString(),
    authKey: t.authKey || '',
    tags: (t.tags || 'tag:server').toString(),
    oauthClientId: t.oauthClientId || '',
    oauthClientSecret: t.oauthClientSecret || '',
    userspace: Boolean(t.userspace),
    funnel: Boolean(t.funnel),
    entrypointPort: Number(t.entrypointPort) || 8443,
    serviceName: (t.serviceName || 'apps').toString(),
    tailnet: (t.tailnet || '').toString(),
  };
}

/**
 * Build the docker-stack compose (YAML) for the Tailscale + DockTail stack.
 * Secret files (authkey / oauth secret) are referenced as external-ish stack
 * secrets created from temp files; their paths are returned for cleanup.
 */
export function buildTailscaleCompose(ts, secretFiles) {
  const L = [];
  L.push("version: '3.8'");
  L.push('services:');

  // --- tailscale sidecar ---
  L.push('  tailscale:');
  L.push(`    image: ${ts.image}`);
  L.push('    hostname: ' + ts.hostname);
  L.push('    environment:');
  L.push('      - TS_STATE_DIR=/var/lib/tailscale');
  L.push('      - TS_SOCKET=/var/run/tailscale/tailscaled.sock');
  L.push(`      - TS_EXTRA_ARGS=--advertise-tags=${ts.tags}`);
  if (ts.userspace) L.push('      - TS_USERSPACE=true');
  else L.push('      - TS_USERSPACE=false');
  if (secretFiles.authKey) L.push('      - TS_AUTHKEY_FILE=/run/secrets/ts_authkey');
  L.push('    volumes:');
  L.push(`      - ${STATE_VOLUME}:/var/lib/tailscale`);
  L.push(`      - ${SOCKET_VOLUME}:/var/run/tailscale`);
  if (!ts.userspace) L.push('      - /dev/net/tun:/dev/net/tun');
  L.push('    cap_add:');
  L.push('      - NET_ADMIN');
  L.push('      - SYS_MODULE');
  if (secretFiles.authKey) { L.push('    secrets:'); L.push('      - ts_authkey'); }
  L.push('    networks:');
  L.push('      - proxynet');
  L.push('    deploy:');
  L.push('      mode: replicated');
  L.push('      replicas: 1');
  L.push('      placement:');
  L.push('        constraints: [node.role == manager]');
  L.push('      restart_policy:');
  L.push('        condition: on-failure');

  // --- docktail ---
  L.push('  docktail:');
  L.push(`    image: ${ts.docktailImage}`);
  L.push('    environment:');
  L.push('      - TS_SOCKET=/var/run/tailscale/tailscaled.sock');
  if (ts.oauthClientId) L.push(`      - TAILSCALE_OAUTH_CLIENT_ID=${ts.oauthClientId}`);
  if (secretFiles.oauthSecret) L.push('      - TAILSCALE_OAUTH_CLIENT_SECRET_FILE=/run/secrets/ts_oauth_secret');
  L.push('    volumes:');
  L.push('      - /var/run/docker.sock:/var/run/docker.sock:ro');
  L.push(`      - ${SOCKET_VOLUME}:/var/run/tailscale`);
  if (secretFiles.oauthSecret) { L.push('    secrets:'); L.push('      - ts_oauth_secret'); }
  L.push('    depends_on:');
  L.push('      - tailscale');
  L.push('    networks:');
  L.push('      - proxynet');
  L.push('    deploy:');
  L.push('      mode: replicated');
  L.push('      replicas: 1');
  L.push('      placement:');
  L.push('        constraints: [node.role == manager]');
  L.push('      restart_policy:');
  L.push('        condition: on-failure');

  L.push('volumes:');
  L.push(`  ${STATE_VOLUME}: {}`);
  L.push(`  ${SOCKET_VOLUME}: {}`);

  const secretsUsed = [];
  if (secretFiles.authKey) secretsUsed.push(['ts_authkey', secretFiles.authKey]);
  if (secretFiles.oauthSecret) secretsUsed.push(['ts_oauth_secret', secretFiles.oauthSecret]);
  if (secretsUsed.length) {
    L.push('secrets:');
    for (const [name, file] of secretsUsed) {
      L.push(`  ${name}:`);
      L.push(`    file: ${file}`);
    }
  }

  L.push('networks:');
  L.push('  proxynet:');
  L.push('    external: true');
  L.push('    name: swarmdash-proxy-net');
  return L.join('\n') + '\n';
}

async function ensureProxyNet() {
  const net = 'swarmdash-proxy-net';
  const nets = await docker.listNetworks({ filters: { name: [net] } });
  if (!nets.some((n) => n.Name === net)) {
    await docker.createNetwork({ Name: net, Driver: 'overlay', Attachable: true });
  }
  return net;
}

function runStackDeploy(file, name) {
  return new Promise((resolve, reject) => {
    const args = ['stack', 'deploy', '--detach=true', '--resolve-image=never', '-c', file, name];
    const child = spawn('docker', args, { env: process.env });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`docker CLI nicht verfügbar: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve((out + err).trim()) : reject(new Error(err.trim() || out.trim() || `Exit ${code}`))));
  });
}

/** Deploy the Tailscale + DockTail stack. Also (re)deploys the Traefik proxy so
 *  it picks up the docktail.* labels that expose the tailnet entrypoint. */
export async function deployTailscaleStack() {
  await requireManager();
  const settings = await loadSettings();
  const ts = tsConfig(settings);
  if (!ts.enable) throw new Error('Tailscale ist nicht aktiviert. Bitte zuerst aktivieren und speichern.');
  if (!ts.authKey && !ts.oauthClientId) {
    throw new Error('Es ist weder ein TS_AUTHKEY noch ein OAuth-Client konfiguriert — der Sidecar könnte sich nicht anmelden.');
  }
  await ensureProxyNet();

  const dir = await mkdtemp(path.join(os.tmpdir(), 'swarmdash-ts-'));
  const composeFile = path.join(dir, 'tailscale-stack.yml');
  const secretFiles = {};
  if (ts.authKey) { secretFiles.authKey = path.join(dir, 'ts_authkey'); await writeFile(secretFiles.authKey, ts.authKey, 'utf8'); }
  if (ts.oauthClientSecret) { secretFiles.oauthSecret = path.join(dir, 'ts_oauth_secret'); await writeFile(secretFiles.oauthSecret, ts.oauthClientSecret, 'utf8'); }

  const compose = buildTailscaleCompose(ts, secretFiles);
  await writeFile(composeFile, compose, 'utf8');
  try {
    const output = await runStackDeploy(composeFile, TS_STACK);
    // Ensure Traefik carries the docktail labels for the tailnet entrypoint.
    let proxyRedeployed = false;
    try {
      const st = await proxyStackStatus();
      if (settings.reverseProxy?.type === 'traefik' && st.deployed) { await deployProxyStack(); proxyRedeployed = true; }
    } catch { /* proxy redeploy best-effort */ }
    return { ok: true, stack: TS_STACK, proxyRedeployed, output };
  } finally {
    await unlink(composeFile).catch(() => {});
    if (secretFiles.authKey) await unlink(secretFiles.authKey).catch(() => {});
    if (secretFiles.oauthSecret) await unlink(secretFiles.oauthSecret).catch(() => {});
  }
}

/** Remove the Tailscale + DockTail stack (leaves state volume by default). */
export async function removeTailscaleStack({ purgeState = false } = {}) {
  await requireManager();
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['stack', 'rm', TS_STACK], { env: process.env });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(e.message)));
    child.on('close', () => resolve());
  });
  let purged = false;
  if (purgeState) {
    // Wait a moment for tasks to release the volume, then remove state.
    await new Promise((r) => setTimeout(r, 3000));
    try { await docker.getVolume(`${TS_STACK}_${STATE_VOLUME}`).remove(); purged = true; }
    catch { try { await docker.getVolume(STATE_VOLUME).remove(); purged = true; } catch { /* in use / gone */ } }
  }
  return { ok: true, stack: TS_STACK, purged };
}

/** Status of the Tailscale + DockTail stack (services + running replicas). */
export async function tailscaleStackStatus() {
  await requireManager();
  const settings = await loadSettings();
  const ts = tsConfig(settings);
  const services = await docker.listServices({ filters: { label: [`com.docker.stack.namespace=${TS_STACK}`] } });
  if (services.length === 0) return { deployed: false, enabled: ts.enable, services: [] };
  const tasks = await docker.listTasks({ filters: { label: [`com.docker.stack.namespace=${TS_STACK}`] } });
  const out = services.map((s) => {
    const running = tasks.filter((t) => t.ServiceID === s.ID && t.Status?.State === 'running').length;
    return {
      id: s.ID,
      name: s.Spec?.Name,
      image: (s.Spec?.TaskTemplate?.ContainerSpec?.Image || '').split('@')[0],
      running,
      desired: s.Spec?.Mode?.Replicated?.Replicas ?? null,
    };
  });
  return { deployed: true, enabled: ts.enable, services: out };
}
