import { docker, requireManager } from './docker.js';
import { updateServiceLabels } from './serviceops.js';
import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { exportForTraefik } from './pki.js';
import {
  loadSettings,
  PROXY_LABEL,
  PROXY_HOST_LABEL,
  PROXY_PORT_LABEL,
  PROXY_ENTRYPOINTS_LABEL,
  PROXY_MTLS_LABEL,
} from './settings.js';

export const PROXY_STACK = 'swarmdash-proxy';
const DEFAULT_NET = 'swarmdash-proxy-net';

const sanitize = (s) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');

function servicePort(spec, explicit) {
  if (explicit) return Number(explicit);
  const ports = spec?.EndpointSpec?.Ports || [];
  if (ports[0]?.TargetPort) return ports[0].TargetPort;
  return 80;
}

/** Compute the routing target for a proxy-tagged service. */
function routing(serviceName, labels, proxy) {
  const host = labels[PROXY_HOST_LABEL] || '';
  if (host) return { mode: 'host', host, path: null };
  const ext = proxy.externalDns;
  if (!ext) throw new Error('Externer DNS-Name im Reverse-Proxy nicht konfiguriert');
  return { mode: 'path', host: ext, path: `/${serviceName}` };
}

/**
 * Decide which entrypoints a tagged service should use.
 * Per-service override label swarmdash.proxy.entrypoints accepts
 * "web", "websecure", or "both" (aka "web,websecure"). Without an override it
 * falls back to the global TLS toggle: TLS on -> websecure, off -> web.
 */
function serviceEntrypoints(labels, proxy) {
  const sel = String(labels[PROXY_ENTRYPOINTS_LABEL] || '').trim().toLowerCase().replace(/\s+/g, '');
  if (sel === 'web') return { web: true, secure: false };
  if (sel === 'websecure' || sel === 'secure') return { web: false, secure: true };
  if (sel === 'both' || sel === 'web,websecure' || sel === 'websecure,web') return { web: true, secure: true };
  return proxy.tls ? { web: false, secure: true } : { web: true, secure: false };
}

/** Build the Traefik deploy labels for a service. */
export function traefikLabels(serviceName, spec, labels, proxy) {
  const r = sanitize(serviceName);
  const route = routing(serviceName, labels, proxy);
  const port = servicePort(spec, labels[PROXY_PORT_LABEL]);
  const eps = serviceEntrypoints(labels, proxy);
  const ruleStr = route.mode === 'host'
    ? `Host(\`${route.host}\`)`
    : `Host(\`${route.host}\`) && PathPrefix(\`${route.path}\`)`;

  const out = {
    'traefik.enable': 'true',
    [`traefik.http.services.${r}.loadbalancer.server.port`]: String(port),
    // Pin the network Traefik uses to reach the backend, since a tagged service
    // is attached to its own network(s) plus the proxy overlay.
    'traefik.docker.network': proxyNetwork(proxy),
  };
  if (route.mode === 'path') {
    out[`traefik.http.middlewares.${r}-strip.stripprefix.prefixes`] = route.path;
  }

  // Secure (HTTPS/websecure) router.
  if (eps.secure) {
    out[`traefik.http.routers.${r}.entrypoints`] = 'websecure';
    out[`traefik.http.routers.${r}.rule`] = ruleStr;
    out[`traefik.http.routers.${r}.service`] = r;
    out[`traefik.http.routers.${r}.tls`] = 'true';
    if (proxy.certResolver && proxy.tlsSource !== 'internal-pki') {
      out[`traefik.http.routers.${r}.tls.certresolver`] = proxy.certResolver;
    }
    // mTLS (client-cert auth) via internal PKI: reference a named tls.options
    // block served by the file provider (see buildPkiProxyPlan).
    if (proxy.tlsSource === 'internal-pki') {
      const mtls = String(labels[PROXY_MTLS_LABEL] || '').trim().toLowerCase();
      if (mtls === 'require') out[`traefik.http.routers.${r}.tls.options`] = 'mtls@file';
      else if (mtls === 'optional') out[`traefik.http.routers.${r}.tls.options`] = 'mtls-optional@file';
    }
    if (route.mode === 'path') out[`traefik.http.routers.${r}.middlewares`] = `${r}-strip`;
  }

  // Plain HTTP (web) router.
  if (eps.web && eps.secure) {
    // Both selected: HTTP router only redirects to HTTPS.
    out[`traefik.http.routers.${r}-http.entrypoints`] = 'web';
    out[`traefik.http.routers.${r}-http.rule`] = ruleStr;
    out[`traefik.http.routers.${r}-http.service`] = r;
    out[`traefik.http.routers.${r}-http.middlewares`] = `${r}-redirect`;
    out[`traefik.http.middlewares.${r}-redirect.redirectscheme.scheme`] = 'https';
    out[`traefik.http.middlewares.${r}-redirect.redirectscheme.permanent`] = 'true';
  } else if (eps.web) {
    // Web only: serve over HTTP, no TLS.
    out[`traefik.http.routers.${r}.entrypoints`] = 'web';
    out[`traefik.http.routers.${r}.rule`] = ruleStr;
    out[`traefik.http.routers.${r}.service`] = r;
    if (route.mode === 'path') out[`traefik.http.routers.${r}.middlewares`] = `${r}-strip`;
  }
  return out;
}

/** Keys that our proxy tagging manages, for clean re-apply / removal. */
function isManagedProxyLabel(key) {
  return key.startsWith('traefik.')
    || key === PROXY_LABEL
    || key === PROXY_HOST_LABEL
    || key === PROXY_PORT_LABEL
    || key === PROXY_ENTRYPOINTS_LABEL
    || key === PROXY_MTLS_LABEL;
}

/** Apply Traefik labels to a single service and attach it to the proxy network. */
export async function applyProxyToService(serviceId) {
  await requireManager();
  const settings = await loadSettings();
  const proxy = settings.reverseProxy;
  if (proxy.type !== 'traefik') {
    throw new Error('Automatisches Anwenden ist nur für Traefik verfügbar (nginx: Config generieren).');
  }
  const net = proxyNetwork(proxy);
  await ensureProxyNetwork(net);
  const netList = await docker.listNetworks({ filters: { name: [net] } });
  const netInfo = netList.find((n) => n.Name === net);

  const svc = docker.getService(serviceId);
  const info = await svc.inspect();
  const labels = info.Spec.Labels || {};
  const applied = traefikLabels(info.Spec.Name, info.Spec, labels, proxy);

  const spec = structuredClone(info.Spec);
  // Drop any previously applied traefik.* labels so a changed entrypoint
  // selection doesn't leave stale routers/middlewares behind. Keep the
  // swarmdash.proxy.* opt-in labels (host/port/entrypoints).
  const kept = {};
  for (const [k, v] of Object.entries(spec.Labels || {})) {
    if (!k.startsWith('traefik.')) kept[k] = v;
  }
  spec.Labels = { ...kept, [PROXY_LABEL]: 'true', ...applied };
  spec.TaskTemplate = spec.TaskTemplate || {};
  const nets = spec.TaskTemplate.Networks || [];
  let attached = false;
  if (netInfo && !nets.some((n) => n.Target === netInfo.Id || n.Target === net)) {
    nets.push({ Target: netInfo.Id });
    attached = true;
  }
  spec.TaskTemplate.Networks = nets;

  await svc.update({ version: info.Version.Index, ...spec });
  return { applied, network: net, attached };
}

/**
 * Remove all reverse-proxy tagging from a service: strips traefik.* and
 * swarmdash.proxy.* labels and detaches it from the proxy overlay network.
 */
export async function removeProxyFromService(serviceId) {
  await requireManager();
  const settings = await loadSettings();
  const net = proxyNetwork(settings.reverseProxy);
  const netList = await docker.listNetworks({ filters: { name: [net] } });
  const netInfo = netList.find((n) => n.Name === net);

  const svc = docker.getService(serviceId);
  const info = await svc.inspect();
  const spec = structuredClone(info.Spec);

  const kept = {};
  let removed = 0;
  for (const [k, v] of Object.entries(spec.Labels || {})) {
    if (isManagedProxyLabel(k)) { removed++; continue; }
    kept[k] = v;
  }
  spec.Labels = kept;

  let detached = false;
  spec.TaskTemplate = spec.TaskTemplate || {};
  const nets = spec.TaskTemplate.Networks || [];
  const filtered = nets.filter((n) => {
    const isProxy = (netInfo && n.Target === netInfo.Id) || n.Target === net;
    if (isProxy) detached = true;
    return !isProxy;
  });
  spec.TaskTemplate.Networks = filtered;

  await svc.update({ version: info.Version.Index, ...spec });
  return { removed, detached, network: net };
}

/**
 * Set the per-service mTLS mode (off|optional|require) and re-apply the Traefik
 * labels so the router picks up (or drops) the tls.options reference.
 */
export async function setServiceMtls(serviceId, mode) {
  await requireManager();
  const m = ['off', 'optional', 'require'].includes(mode) ? mode : 'off';
  const svc = docker.getService(serviceId);
  const info = await svc.inspect();
  const spec = structuredClone(info.Spec);
  spec.Labels = spec.Labels || {};
  if (m === 'off') delete spec.Labels[PROXY_MTLS_LABEL];
  else spec.Labels[PROXY_MTLS_LABEL] = m;
  await svc.update({ version: info.Version.Index, ...spec });
  const applied = await applyProxyToService(serviceId);
  return { mtls: m, ...applied };
}

/** List services tagged for reverse-proxy use (+ resolved routing). */
export async function listProxyServices() {
  await requireManager();
  const settings = await loadSettings();
  const proxy = settings.reverseProxy;
  const net = proxyNetwork(proxy);
  const netList = await docker.listNetworks({ filters: { name: [net] } });
  const netInfo = netList.find((n) => n.Name === net);
  const services = await docker.listServices();
  const out = [];
  for (const s of services) {
    const labels = s.Spec?.Labels || {};
    const val = labels[PROXY_LABEL];
    if (val !== 'true' && val !== '1') continue;
    let route = null;
    try {
      route = routing(s.Spec.Name, labels, proxy);
    } catch {
      route = { mode: 'unconfigured', host: null, path: null };
    }
    const nets = s.Spec?.TaskTemplate?.Networks || [];
    const attached = nets.some((n) => (netInfo && n.Target === netInfo.Id) || n.Target === net);
    out.push({
      id: s.ID,
      name: s.Spec.Name,
      host: labels[PROXY_HOST_LABEL] || null,
      port: servicePort(s.Spec, labels[PROXY_PORT_LABEL]),
      entrypoints: labels[PROXY_ENTRYPOINTS_LABEL] || null,
      mtls: labels[PROXY_MTLS_LABEL] || null,
      applied: Boolean(labels['traefik.enable']),
      attached,
      route,
    });
  }
  return out;
}

/** Generate an nginx reverse-proxy config for all tagged services. */
export async function generateNginxConfig() {
  const settings = await loadSettings();
  const proxy = settings.reverseProxy;
  const services = await listProxyServices();
  const lines = [
    '# Auto-generated by Swarm Dashboard',
    '# Place inside the nginx http{} context; nginx must share an overlay network with the services.',
    '',
  ];

  const hostGroups = new Map(); // host -> [{name, port, path}]
  for (const s of services) {
    const host = s.route.host || proxy.externalDns || '_';
    if (!hostGroups.has(host)) hostGroups.set(host, []);
    hostGroups.get(host).push({ name: s.name, port: s.port, path: s.route.path });
  }

  for (const [host, entries] of hostGroups) {
    lines.push(`server {`);
    lines.push(`    listen ${proxy.tls ? '443 ssl' : '80'};`);
    lines.push(`    server_name ${host};`);
    if (proxy.tls) {
      lines.push('    # ssl_certificate     /etc/nginx/certs/fullchain.pem;');
      lines.push('    # ssl_certificate_key /etc/nginx/certs/privkey.pem;');
    }
    for (const e of entries) {
      const loc = e.path ? `${e.path}/` : '/';
      lines.push('');
      lines.push(`    location ${loc} {`);
      lines.push(`        proxy_pass http://${e.name}:${e.port}/;`);
      lines.push('        proxy_set_header Host $host;');
      lines.push('        proxy_set_header X-Real-IP $remote_addr;');
      lines.push('        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
      lines.push('        proxy_set_header X-Forwarded-Proto $scheme;');
      lines.push('    }');
    }
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Proxy stack deployment                                             */
/* ------------------------------------------------------------------ */

/** The overlay network the proxy shares with target services. */
export function proxyNetwork(proxy) {
  return (proxy.network && proxy.network.trim()) || DEFAULT_NET;
}

/**
 * nginx config for the docker-socket proxy sidecar. Traefik's swarm provider
 * pins the Docker API to v1.24, which Docker Engine 29+ rejects ("client
 * version 1.24 is too old"). This tiny nginx rewrites the API version prefix
 * (/v1.24/... -> /v1.44/...) and forwards to the unix socket, so Traefik can
 * talk to a modern daemon unchanged. proxy_buffering off keeps the /events
 * stream live.
 */
export function dockerProxyNginxConf() {
  return [
    'user root;',
    'events {}',
    'http {',
    '  upstream dockersock { server unix:/var/run/docker.sock; }',
    '  server {',
    '    listen 2375;',
    '    proxy_http_version 1.1;',
    '    proxy_buffering off;',
    '    proxy_read_timeout 3600s;',
    '    location ~ ^/v[0-9.]+/(?<rest>.*)$ {',
    '      proxy_pass http://dockersock/v1.44/$rest$is_args$args;',
    '    }',
    '    location / { proxy_pass http://dockersock; }',
    '  }',
    '}',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Internal PKI wiring (Traefik file provider)                        */
/* ------------------------------------------------------------------ */

/** Traefik dynamic TLS config: cert pool, default cert, and mTLS options. */
function pkiDynamicYaml(certs) {
  const p = (s, ext) => `/etc/traefik/dynamic/${s}.${ext}`;
  const caPath = '/etc/traefik/dynamic/ca.crt';
  const lines = ['tls:', '  certificates:'];
  for (const c of certs) {
    lines.push(`    - certFile: ${p(c.serialHex, 'crt')}`);
    lines.push(`      keyFile: ${p(c.serialHex, 'key')}`);
  }
  const def = certs[0];
  lines.push('  stores:');
  lines.push('    default:');
  lines.push('      defaultCertificate:');
  lines.push(`        certFile: ${p(def.serialHex, 'crt')}`);
  lines.push(`        keyFile: ${p(def.serialHex, 'key')}`);
  // mTLS client-cert options (referenced per-router via tls.options=mtls@file).
  lines.push('  options:');
  lines.push('    mtls:');
  lines.push('      clientAuth:');
  lines.push('        caFiles:');
  lines.push(`          - ${caPath}`);
  lines.push('        clientAuthType: RequireAndVerifyClientCert');
  lines.push('    mtls-optional:');
  lines.push('      clientAuth:');
  lines.push('        caFiles:');
  lines.push(`          - ${caPath}`);
  lines.push('        clientAuthType: VerifyClientCertIfGiven');
  return `${lines.join('\n')}\n`;
}

/**
 * Assemble the Swarm-config plan that injects the internal PKI into Traefik.
 * With `dir` the PEM/YAML files are written there (deploy); without it,
 * placeholder file paths are returned (compose preview). Returns null when
 * there is nothing to serve (no CA / no certs).
 *
 * Config keys: per-serial cert/key content is immutable, so `pki_c<serial>` /
 * `pki_k<serial>` are stable and reused across deploys. The dynamic tls.yml
 * carries a content hash (`pki_tls_<hash>`) so a changed cert set yields a new
 * config object instead of colliding with the immutable existing one.
 */
export async function buildPkiProxyPlan(dir) {
  const { ca, certs } = await exportForTraefik();
  if (!certs.length) return null;
  const dynamic = pkiDynamicYaml(certs);
  const hash = crypto.createHash('sha256').update(dynamic).digest('hex').slice(0, 10);
  const configs = [];
  const put = async (name, content) => {
    const file = dir ? path.join(dir, name) : `/run/swarmdash/${name}`;
    if (dir) await writeFile(file, content, 'utf8');
    return file;
  };
  configs.push({
    key: `pki_tls_${hash}`,
    target: '/etc/traefik/dynamic/tls.yml',
    file: await put('pki-tls.yml', dynamic),
  });
  // CA cert for mTLS client verification (stable content -> stable key).
  if (ca) {
    configs.push({ key: 'pki_ca', target: '/etc/traefik/dynamic/ca.crt', file: await put('pki-ca.crt', ca) });
  }
  for (const c of certs) {
    configs.push({ key: `pki_c${c.serialHex}`, target: `/etc/traefik/dynamic/${c.serialHex}.crt`, file: await put(`pki-${c.serialHex}.crt`, c.certPem) });
    configs.push({ key: `pki_k${c.serialHex}`, target: `/etc/traefik/dynamic/${c.serialHex}.key`, file: await put(`pki-${c.serialHex}.key`, c.keyPem) });
  }
  return { hash, count: certs.length, configs };
}

/** Remove orphaned PKI proxy configs no longer referenced by the current plan. */
async function prunePkiConfigs(keepNames) {
  let removed = 0;
  try {
    const configs = await docker.listConfigs({ filters: { label: [`com.docker.stack.namespace=${PROXY_STACK}`] } });
    for (const c of configs) {
      const name = c.Spec?.Name || '';
      if (!name.startsWith(`${PROXY_STACK}_pki_`) || keepNames.has(name)) continue;
      try { await docker.getConfig(c.ID).remove(); removed += 1; }
      catch { /* in-use during rollout — retry next deploy */ }
    }
  } catch { /* best effort */ }
  return removed;
}

const DEFAULT_TRAEFIK_IMAGE = 'traefik:v3.7.13';
/** Resolve the traefik image to deploy: use the configured tag, else the pinned
 *  default. A blank/whitespace value falls back to the default; never :latest by
 *  accident. Basic sanity check keeps the compose YAML well-formed. */
export function traefikImage(proxy) {
  const raw = String(proxy?.traefikImage || '').trim();
  if (!raw) return DEFAULT_TRAEFIK_IMAGE;
  // Reject characters that could break the YAML line / inject options.
  if (/[\s'"`$]/.test(raw)) return DEFAULT_TRAEFIK_IMAGE;
  return raw;
}

/** Build the docker-stack compose (YAML string) for the configured proxy. */
export async function buildProxyCompose(proxy, nginxConf, dockerProxyConf, pki = null) {
  const net = proxyNetwork(proxy);
  if (proxy.type === 'traefik') {
    const cmd = [
      '--providers.swarm=true',
      '--providers.swarm.endpoint=tcp://dockerproxy:2375',
      '--providers.swarm.exposedByDefault=false',
      `--providers.swarm.network=${net}`,
      '--entrypoints.web.address=:80',
      '--entrypoints.websecure.address=:443',
    ];
    const usePki = proxy.tlsSource === 'internal-pki' && pki && pki.configs.length > 0;
    const useAcme = proxy.tls && !usePki && proxy.certResolver && proxy.acmeEmail;
    if (usePki) {
      cmd.push('--providers.file.filename=/etc/traefik/dynamic/tls.yml');
      cmd.push('--providers.file.watch=true');
    }
    if (useAcme) {
      cmd.push(`--certificatesresolvers.${proxy.certResolver}.acme.email=${proxy.acmeEmail}`);
      cmd.push(`--certificatesresolvers.${proxy.certResolver}.acme.storage=/acme/acme.json`);
      cmd.push(`--certificatesresolvers.${proxy.certResolver}.acme.httpchallenge.entrypoint=web`);
    }

    // Traefik dashboard: routed securely via the external DNS name when set,
    // otherwise exposed on the insecure API port 8080.
    const wantDash = proxy.dashboard !== false;
    const dashSecure = wantDash && proxy.externalDns;
    const dashInsecure = wantDash && !proxy.externalDns;
    if (wantDash) cmd.push('--api.dashboard=true');
    if (dashInsecure) cmd.push('--api.insecure=true');

    const dashLabels = [];
    if (dashSecure) {
      // Entrypoint & scheme derive from the TLS toggle so the router and the
      // status URL always match: TLS on -> websecure/:443/https, off -> web/:80/http.
      const ep = proxy.tls ? 'websecure' : 'web';
      dashLabels.push('traefik.enable=true');
      dashLabels.push(`traefik.http.routers.traefik-dashboard.rule=Host(\`${proxy.externalDns}\`) && (PathPrefix(\`/dashboard\`) || PathPrefix(\`/api\`))`);
      dashLabels.push('traefik.http.routers.traefik-dashboard.service=api@internal');
      dashLabels.push(`traefik.http.routers.traefik-dashboard.entrypoints=${ep}`);
      dashLabels.push(`traefik.http.services.traefik-dashboard.loadbalancer.server.port=8080`);
      if (proxy.tls) dashLabels.push('traefik.http.routers.traefik-dashboard.tls=true');
      if (useAcme) dashLabels.push(`traefik.http.routers.traefik-dashboard.tls.certresolver=${proxy.certResolver}`);
      dashLabels.push(`traefik.docker.network=${net}`);
    }

    const lines = [];
    lines.push("version: '3.8'");
    lines.push('services:');
    lines.push('  dockerproxy:');
    lines.push('    image: nginx:alpine');
    lines.push('    configs:');
    lines.push('      - source: swarmdash_dockerproxy_conf');
    lines.push('        target: /etc/nginx/nginx.conf');
    lines.push('    volumes:');
    lines.push('      - /var/run/docker.sock:/var/run/docker.sock:ro');
    lines.push('    networks:');
    lines.push('      - proxynet');
    lines.push('    deploy:');
    lines.push('      mode: replicated');
    lines.push('      replicas: 1');
    lines.push('      placement:');
    lines.push('        constraints: [node.role == manager]');
    lines.push('      restart_policy:');
    lines.push('        condition: on-failure');
    lines.push('  traefik:');
    lines.push(`    image: ${traefikImage(proxy)}`);
    lines.push('    command:');
    for (const c of cmd) lines.push(`      - "${c}"`);
    lines.push('    ports:');
    lines.push('      - { target: 80, published: 80, mode: host }');
    lines.push('      - { target: 443, published: 443, mode: host }');
    if (dashInsecure) lines.push('      - { target: 8080, published: 8080, mode: host }');
    if (useAcme) {
      lines.push('    volumes:');
      lines.push('      - traefik-acme:/acme');
    }
    if (usePki) {
      lines.push('    configs:');
      for (const c of pki.configs) {
        lines.push(`      - source: ${c.key}`);
        lines.push(`        target: ${c.target}`);
      }
    }
    lines.push('    networks:');
    lines.push(`      - proxynet`);
    lines.push('    deploy:');
    lines.push('      mode: replicated');
    lines.push('      replicas: 1');
    lines.push('      placement:');
    lines.push('        constraints: [node.role == manager]');
    lines.push('      restart_policy:');
    lines.push('        condition: on-failure');
    if (dashSecure) {
      lines.push('      labels:');
      for (const l of dashLabels) lines.push(`        - "${l}"`);
    }
    lines.push('configs:');
    lines.push('  swarmdash_dockerproxy_conf:');
    lines.push(`    file: ${dockerProxyConf}`);
    if (usePki) {
      for (const c of pki.configs) {
        lines.push(`  ${c.key}:`);
        lines.push(`    file: ${c.file}`);
      }
    }
    if (useAcme) { lines.push('volumes:'); lines.push('  traefik-acme: {}'); }
    lines.push('networks:');
    lines.push('  proxynet:');
    lines.push('    external: true');
    lines.push(`    name: ${net}`);
    return lines.join('\n') + '\n';
  }

  if (proxy.type === 'nginx') {
    const lines = [];
    lines.push("version: '3.8'");
    lines.push('services:');
    lines.push('  nginx:');
    lines.push('    image: nginx:alpine');
    lines.push('    ports:');
    lines.push('      - { target: 80, published: 80, mode: host }');
    if (proxy.tls) lines.push('      - { target: 443, published: 443, mode: host }');
    lines.push('    configs:');
    lines.push('      - source: swarmdash_nginx_conf');
    lines.push('        target: /etc/nginx/conf.d/default.conf');
    lines.push('    networks:');
    lines.push('      - proxynet');
    lines.push('    deploy:');
    lines.push('      mode: replicated');
    lines.push('      replicas: 1');
    lines.push('      placement:');
    lines.push('        constraints: [node.role == manager]');
    lines.push('      restart_policy:');
    lines.push('        condition: on-failure');
    lines.push('configs:');
    lines.push('  swarmdash_nginx_conf:');
    lines.push(`    file: ${nginxConf}`);
    lines.push('networks:');
    lines.push('  proxynet:');
    lines.push('    external: true');
    lines.push(`    name: ${net}`);
    return lines.join('\n') + '\n';
  }

  throw new Error('Kein Proxy-Typ ausgewählt (traefik oder nginx erforderlich)');
}

/** Ensure the shared overlay network exists (attachable). */
async function ensureProxyNetwork(net) {
  const nets = await docker.listNetworks({ filters: { name: [net] } });
  if (nets.some((n) => n.Name === net)) return;
  await docker.createNetwork({ Name: net, Driver: 'overlay', Attachable: true });
}

/** Deploy (create + start) the configured reverse proxy as a swarm stack. */
export async function deployProxyStack() {
  await requireManager();
  const settings = await loadSettings();
  const proxy = settings.reverseProxy;
  if (proxy.type !== 'traefik' && proxy.type !== 'nginx') {
    throw new Error('Kein Reverse Proxy ausgewählt. Bitte zuerst Typ (Traefik/nginx) wählen und speichern.');
  }
  const net = proxyNetwork(proxy);
  await ensureProxyNetwork(net);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'swarmdash-proxy-'));
  const composeFile = path.join(dir, 'proxy-stack.yml');
  let nginxConf = null;
  let dockerProxyConf = null;
  if (proxy.type === 'nginx') {
    nginxConf = path.join(dir, 'nginx.conf');
    await writeFile(nginxConf, await generateNginxConfig(), 'utf8');
  }
  if (proxy.type === 'traefik') {
    dockerProxyConf = path.join(dir, 'dockerproxy.conf');
    await writeFile(dockerProxyConf, dockerProxyNginxConf(), 'utf8');
  }
  let pki = null;
  if (proxy.type === 'traefik' && proxy.tlsSource === 'internal-pki') {
    pki = await buildPkiProxyPlan(dir);
  }
  const compose = await buildProxyCompose(proxy, nginxConf, dockerProxyConf, pki);
  await writeFile(composeFile, compose, 'utf8');

  try {
    const output = await runDockerStackDeploy(composeFile, PROXY_STACK);
    // Always prune orphaned PKI configs — including when the plan is empty
    // (pki === null), so a reset/removal never leaves stale configs behind that
    // Traefik would keep serving. keepNames is empty when there is no plan.
    const keepNames = new Set((pki ? pki.configs : []).map((c) => `${PROXY_STACK}_${c.key}`));
    const prunedOrphans = await prunePkiConfigs(keepNames);
    return { ok: true, stack: PROXY_STACK, type: proxy.type, network: net, tlsSource: proxy.tlsSource, pkiCerts: pki ? pki.count : 0, prunedOrphans, output };
  } finally {
    await unlink(composeFile).catch(() => {});
    if (nginxConf) await unlink(nginxConf).catch(() => {});
    if (dockerProxyConf) await unlink(dockerProxyConf).catch(() => {});
  }
}

function runDockerStackDeploy(file, name) {
  return new Promise((resolve, reject) => {
    const args = ['stack', 'deploy', '--detach=true', '--resolve-image=never', '-c', file, name];
    const child = spawn('docker', args, { env: process.env });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`docker CLI nicht verfügbar: ${e.message}`)));
    child.on('close', (code) => {
      // Note: image resolution warnings are printed to stderr but exit 0.
      if (code === 0) resolve((out + err).trim());
      else reject(new Error(err.trim() || out.trim() || `Exit ${code}`));
    });
  });
}

/**
 * Reconcile the Traefik runtime with the current PKI state. Call this after a
 * PKI change that REMOVES material (reset, delete, revoke) so Traefik stops
 * serving certificates that no longer exist and orphaned Swarm configs get
 * pruned. Safe no-op when the proxy is not a deployed internal-PKI Traefik.
 * Never throws — returns a small result object describing what happened.
 */
export async function reconcilePkiProxy() {
  try {
    const settings = await loadSettings();
    const proxy = settings.reverseProxy;
    const status = await proxyStackStatus();
    if (proxy.type === 'traefik' && proxy.tlsSource === 'internal-pki' && status.deployed) {
      const r = await deployProxyStack();
      return { reconciled: true, redeployed: true, prunedOrphans: r.prunedOrphans ?? 0, pkiCerts: r.pkiCerts ?? 0 };
    }
    // Not actively using internal-PKI (or nothing deployed): the configs are not
    // mounted, so we can drop any leftover pki_* config objects directly.
    const removed = await prunePkiConfigs(new Set());
    return { reconciled: true, redeployed: false, prunedOrphans: removed };
  } catch (e) {
    return { reconciled: false, error: e.message };
  }
}

/** Status of the deployed proxy stack (services + running replicas). */
export async function proxyStackStatus() {
  await requireManager();
  const settings = await loadSettings();
  const proxy = settings.reverseProxy;
  const services = await docker.listServices({
    filters: { label: [`com.docker.stack.namespace=${PROXY_STACK}`] },
  });
  // Dashboard URL hint (traefik only).
  let dashboard = null;
  if (proxy.type === 'traefik' && proxy.dashboard !== false) {
    dashboard = proxy.externalDns
      ? { mode: 'secure', url: `${proxy.tls ? 'https' : 'http'}://${proxy.externalDns}/dashboard/` }
      : { mode: 'insecure', url: 'http://<node>:8080/dashboard/' };
  }
  if (services.length === 0) return { deployed: false, services: [], dashboard };
  const tasks = await docker.listTasks({ filters: { label: [`com.docker.stack.namespace=${PROXY_STACK}`] } });
  const out = services.map((s) => {
    const running = tasks.filter((t) => t.ServiceID === s.ID && t.Status?.State === 'running').length;
    const desired = s.Spec?.Mode?.Replicated?.Replicas ?? null;
    return {
      id: s.ID,
      name: s.Spec?.Name,
      image: (s.Spec?.TaskTemplate?.ContainerSpec?.Image || '').split('@')[0],
      running,
      desired,
      ports: (s.Endpoint?.Ports || []).map((p) => `${p.PublishedPort}->${p.TargetPort}`),
    };
  });
  const allUp = out.every((s) => s.desired == null || s.running >= s.desired) && out.some((s) => s.running > 0);
  return { deployed: true, healthy: allUp, services: out, dashboard };
}

/** Remove the deployed proxy stack. */
export async function removeProxyStack() {
  await requireManager();
  const ns = `com.docker.stack.namespace=${PROXY_STACK}`;
  const filters = { label: [ns] };
  const [services, networks, configs] = await Promise.all([
    docker.listServices({ filters }),
    docker.listNetworks({ filters }),
    docker.listConfigs({ filters }),
  ]);
  for (const s of services) await docker.getService(s.ID).remove().catch(() => {});
  for (const c of configs) await docker.getConfig(c.ID).remove().catch(() => {});
  for (const n of networks) await docker.getNetwork(n.Id).remove().catch(() => {});
  return { ok: true, removed: services.length };
}