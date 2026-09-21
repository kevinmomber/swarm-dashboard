import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR =
  process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const BACKUP_LABEL = 'swarmdash.backup';
export const BACKUP_VOLUMES_LABEL = 'swarmdash.backup.volumes';
export const PROXY_LABEL = 'swarmdash.proxy';
export const PROXY_HOST_LABEL = 'swarmdash.proxy.host';
export const PROXY_PORT_LABEL = 'swarmdash.proxy.port';
export const PROXY_ENTRYPOINTS_LABEL = 'swarmdash.proxy.entrypoints';
export const PROXY_MTLS_LABEL = 'swarmdash.proxy.mtls'; // off | optional | require
export const PROXY_TAILNET_LABEL = 'swarmdash.proxy.tailnet'; // 'true' -> reachable over Tailscale (via the dedicated tailnet entrypoint)
export const GROUP_LABEL = 'swarmdash.tag';
export const MONITOR_LABEL = 'swarmdash.monitor';

const DEFAULTS = {
  theme: 'dark', // 'dark' | 'light'
  backup: {
    // Shared destination for all jobs.
    target: {
      type: 'local', // 'local' | 'smb'
      localPath: '/backups',
      smb: {
        host: '',
        share: '',
        subPath: '',
        username: '',
        password: '', // stored server-side only, never returned
        domain: '',
        version: '3.0',
      },
    },
    // Multiple independent schedules, each selecting services by backup tag value.
    jobs: [
      {
        id: 'default',
        name: 'Standard',
        enabled: false,
        schedule: '0 3 * * *', // cron
        retention: 7,
        tag: 'true', // matches services labelled swarmdash.backup=<tag>
      },
    ],
  },
  reverseProxy: {
    type: 'none', // 'none' | 'traefik' | 'nginx'
    externalDns: '', // e.g. apps.example.com
    entrypoint: 'websecure', // traefik entrypoint
    certResolver: '', // traefik ACME resolver (optional)
    acmeEmail: '', // e-mail for the ACME/Let's Encrypt resolver (traefik)
    tlsSource: 'acme', // 'acme' | 'internal-pki' — where HTTPS certs come from (traefik)
    network: '', // traefik swarm overlay network (optional)
    traefikImage: 'traefik:v3.7.13', // pinned traefik image (configurable, avoid :latest)
    dashboard: true, // deploy the traefik dashboard alongside the proxy
    tls: true,
  },
  // Tailscale + DockTail: run tailscaled and DockTail as a managed stack and
  // expose selected services over the tailnet. A-verfeinert: DockTail publishes
  // ONLY Traefik's dedicated 'tailnet' entrypoint; services opt in per label
  // (swarmdash.proxy.tailnet=true) which adds a path router on that entrypoint.
  tailscale: {
    enable: false, // master toggle for the whole feature
    image: 'tailscale/tailscale:latest', // sidecar image (pin in prod)
    docktailImage: 'ghcr.io/marvinvr/docktail:latest', // docktail image
    hostname: 'swarmdash', // tailscale node hostname (becomes the tailnet host)
    authKey: '', // TS_AUTHKEY (secret; server-side only, never returned)
    tags: 'tag:server', // --advertise-tags for the sidecar
    oauthClientId: '', // optional: DockTail auto service creation
    oauthClientSecret: '', // secret; server-side only
    userspace: false, // true = TS_USERSPACE (no /dev/net/tun); false = kernel mode
    funnel: false, // expose the tailnet entrypoint publicly via Funnel
    entrypointPort: 8443, // must match the Traefik 'tailnet' entrypoint
    serviceName: 'apps', // DockTail service name (tailnet hostname for the Traefik entrypoint)
    tailnet: '', // informational: your tailnet (….ts.net), display only
  },
  monitoring: {
    enabled: false,
    intervalSec: 60,
    thresholds: { cpu: 90, mem: 90, disk: 90 }, // percent
    serviceTag: 'true', // monitor services labelled swarmdash.monitor=<tag>
    mqttStatus: true, // publish periodic status messages to MQTT
    certExpiryDays: 30, // alert when a CA/cert expires within this many days
    checkCertExpiry: true, // proactive PKI expiry alerts
    checkEndpoints: true, // alert when a registered Docker endpoint is unreachable
    alerts: {
      webhook: { enabled: false, url: '' },
      matrix: { enabled: false, homeserver: '', accessToken: '', roomId: '' },
      mqtt: { enabled: false, url: '', topicPrefix: 'swarmdash', username: '', password: '' },
      email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' },
    },
  },
  history: [], // [{ id, jobId, jobName, startedAt, finishedAt, status, volumes:[...], error }]
  monitorLog: [], // [{ at, level, target, message }]
  registries: [], // [{ id, name, url, username, password }]
  git: [], // [{ id, name, url, branch, composePath, token }]
  gitops: [], // [{ id, name, gitId, stackName, composePath, autoDeploy, intervalMin, lastSha, lastDeployedAt, lastStatus, lastError }]
  builder: {
    // Saved Dockerfiles for the Builder tab and recent build history.
    dockerfiles: [], // [{ id, name, content, updatedAt }]
    history: [], // [{ id, tag, startedAt, finishedAt, status, pushed, error }]
  },
};

let cache = null;

function deepMerge(base, override) {
  if (Array.isArray(base)) return override ?? base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    for (const k of Object.keys(base)) {
      if (override && k in override) out[k] = deepMerge(base[k], override[k]);
    }
    // keep unknown keys from override too (e.g. history entries)
    if (override) for (const k of Object.keys(override)) if (!(k in out)) out[k] = override[k];
    return out;
  }
  return override ?? base;
}

export async function loadSettings() {
  if (cache) return cache;
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    cache = deepMerge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

export async function saveSettings(next) {
  await mkdir(DATA_DIR, { recursive: true });
  cache = next;
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return cache;
}

/** Public view: never leak secrets; expose only whether one is set. */
export function redact(settings) {
  const s = structuredClone(settings);
  const smb = s.backup?.target?.smb;
  if (smb) { smb.hasPassword = Boolean(smb.password); delete smb.password; }

  const a = s.monitoring?.alerts;
  if (a) {
    if (a.mqtt) { a.mqtt.hasPassword = Boolean(a.mqtt.password); delete a.mqtt.password; }
    if (a.matrix) { a.matrix.hasToken = Boolean(a.matrix.accessToken); delete a.matrix.accessToken; }
    if (a.email) { a.email.hasPass = Boolean(a.email.pass); delete a.email.pass; }
  }
  if (Array.isArray(s.history)) s.history = s.history.slice(-50).reverse();
  if (Array.isArray(s.monitorLog)) s.monitorLog = s.monitorLog.slice(-100).reverse();
  if (Array.isArray(s.registries)) s.registries = s.registries.map(({ password, ...r }) => ({ ...r, hasPassword: Boolean(password) }));
  if (Array.isArray(s.git)) s.git = s.git.map(({ token, ...g }) => ({ ...g, hasToken: Boolean(token) }));

  const ts = s.tailscale;
  if (ts) {
    ts.hasAuthKey = Boolean(ts.authKey); delete ts.authKey;
    ts.hasOauthSecret = Boolean(ts.oauthClientSecret); delete ts.oauthClientSecret;
  }
  return s;
}

/**
 * Apply an incoming (redacted) patch onto stored settings.
 * Secrets are only overwritten when a non-empty value is provided.
 */
export function applyPatch(current, patch) {
  const merged = deepMerge(structuredClone(current), patch);

  const keepSecret = (path, key) => {
    const cur = path.reduce((o, k) => o?.[k], current);
    const mrg = path.reduce((o, k) => o?.[k], merged);
    const inc = path.reduce((o, k) => o?.[k], patch);
    if (mrg && (!inc || !inc[key])) mrg[key] = cur?.[key] || '';
  };
  keepSecret(['backup', 'target', 'smb'], 'password');
  keepSecret(['monitoring', 'alerts', 'mqtt'], 'password');
  keepSecret(['monitoring', 'alerts', 'matrix'], 'accessToken');
  keepSecret(['monitoring', 'alerts', 'email'], 'pass');
  keepSecret(['tailscale'], 'authKey');
  keepSecret(['tailscale'], 'oauthClientSecret');

  if (merged.backup?.target?.smb) delete merged.backup.target.smb.hasPassword;
  if (merged.monitoring?.alerts?.mqtt) delete merged.monitoring.alerts.mqtt.hasPassword;
  if (merged.monitoring?.alerts?.matrix) delete merged.monitoring.alerts.matrix.hasToken;
  if (merged.monitoring?.alerts?.email) delete merged.monitoring.alerts.email.hasPass;
  if (merged.tailscale) { delete merged.tailscale.hasAuthKey; delete merged.tailscale.hasOauthSecret; }

  merged.history = current.history || []; // managed by the backup engine
  merged.monitorLog = current.monitorLog || []; // managed by the monitor
  merged.registries = current.registries || []; // managed by dedicated endpoints
  merged.git = current.git || []; // managed by dedicated endpoints
  merged.gitops = current.gitops || []; // managed by dedicated endpoints
  return merged;
}

export function appendMonitorLog(settings, entry) {
  settings.monitorLog = [...(settings.monitorLog || []), entry].slice(-500);
  return settings;
}

export function appendHistory(settings, entry) {
  settings.history = [...(settings.history || []), entry].slice(-200);
  return settings;
}
