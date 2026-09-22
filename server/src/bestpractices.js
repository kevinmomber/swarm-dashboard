/**
 * Best-practice scanner for the Swarm manager (Phase 1).
 *
 * A READ-ONLY rule engine that gathers facts via the manager's Docker socket
 * (info, nodes, services, tasks, networks, secrets) and evaluates a catalogue of
 * infrastructure- and security-oriented best-practice rules. Each rule yields a
 * status (pass|warn|fail|na), a severity, a human-readable detail, the offending
 * objects, and a concrete remediation hint. No changes are ever made.
 *
 * Phase 1 uses only manager-socket data (no host access); host/daemon-level CIS
 * checks that need per-node host access are a later phase (via the agent).
 */
import { docker, requireManager } from './docker.js';
import { agentBaseForNode } from './metrics.js';

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

const SYSTEM_STACKS = new Set(['swarm-dashboard', 'swarmdash-proxy', 'swarmdash-tailscale']);
const SYSTEM_NAME_RE = /^(swarm-dashboard|swarmdash)/;

const isLatest = (image) => {
  const ref = (image || '').split('@')[0]; // drop digest
  if (image && image.includes('@sha256:')) return false; // pinned by digest → fine
  const tag = ref.includes('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref;
  if (!tag.includes(':')) return true; // no tag → :latest implied
  const t = tag.slice(tag.indexOf(':') + 1);
  return t === 'latest' || t === '';
};

const svcLabel = (s) => s.Spec?.Name || s.ID;
const stackOf = (s) => s.Spec?.Labels?.['com.docker.stack.namespace'] || null;
const isSystem = (s) => SYSTEM_STACKS.has(stackOf(s)) || SYSTEM_NAME_RE.test(svcLabel(s));

/** Build a single check result. */
function mk(id, category, title, severity, status, detail, remediation, objects = []) {
  return { id, category, title, severity, status, detail, remediation, objects };
}

export async function runBestPractices() {
  await requireManager();
  const [info, nodes, services, tasks, networks, secrets] = await Promise.all([
    docker.info().catch(() => ({})),
    docker.listNodes().catch(() => []),
    docker.listServices().catch(() => []),
    docker.listTasks().catch(() => []),
    docker.listNetworks().catch(() => []),
    docker.listSecrets().catch(() => []),
  ]);

  const checks = [];
  const userServices = services.filter((s) => !isSystem(s));
  const appServices = userServices.length ? userServices : services; // fall back if only system present

  /* ---------------------- Infrastructure ---------------------- */

  // INFRA-01: manager count odd and >=3
  const managers = nodes.filter((n) => n.Spec?.Role === 'manager');
  const mc = managers.length;
  checks.push(mk('INFRA-01', 'infra', 'Manager-Quorum (ungerade, ≥ 3)', 'high',
    mc >= 3 && mc % 2 === 1 ? 'pass' : (mc <= 1 ? 'fail' : 'warn'),
    `${mc} Manager-Node(s) im Swarm.`,
    'Betreibe 3 oder 5 Manager (ungerade Anzahl) für Raft-Quorum und Ausfallsicherheit. Ein einzelner Manager ist ein Single Point of Failure.'));

  // INFRA-02: managers not running user workloads
  const mgrNodeIds = new Set(managers.map((n) => n.ID));
  const svcById = new Map(services.map((s) => [s.ID, s]));
  const userOnMgr = new Set();
  for (const t of tasks) {
    if (t.NodeID && mgrNodeIds.has(t.NodeID) && (t.Status?.State === 'running')) {
      const s = svcById.get(t.ServiceID);
      if (s && !isSystem(s)) userOnMgr.add(svcLabel(s));
    }
  }
  checks.push(mk('INFRA-02', 'infra', 'Manager-Nodes ohne Anwendungslast', 'medium',
    userOnMgr.size === 0 ? 'pass' : 'warn',
    userOnMgr.size ? `${userOnMgr.size} Anwendungs-Service(s) laufen auf Manager-Nodes.` : 'Keine Anwendungslast auf Managern.',
    'Manager möglichst dediziert halten (Availability=drain) oder Workloads per Placement-Constraint auf Worker lenken, damit die Control-Plane stabil bleibt.',
    [...userOnMgr]));

  // INFRA-03: swarm autolock
  const autolock = info.Swarm?.Cluster?.Spec?.EncryptionConfig?.AutoLockManagers;
  checks.push(mk('INFRA-03', 'infra', 'Swarm-Autolock aktiviert', 'medium',
    autolock ? 'pass' : 'warn',
    autolock ? 'Autolock ist aktiv.' : 'Autolock ist nicht aktiv.',
    'Autolock (docker swarm update --autolock=true) verschlüsselt die Raft-Logs/TLS-Keys im Ruhezustand; ohne ihn liegen Manager-Secrets unverschlüsselt auf der Platte.'));

  // INFRA-04: overlay networks encrypted
  const overlays = networks.filter((n) => n.Driver === 'overlay' && n.Name !== 'ingress');
  const unenc = overlays.filter((n) => String(n.Options?.encrypted || 'false') !== 'true').map((n) => n.Name);
  checks.push(mk('INFRA-04', 'infra', 'Overlay-Netzwerke verschlüsselt', 'medium',
    overlays.length === 0 ? 'na' : (unenc.length === 0 ? 'pass' : 'warn'),
    overlays.length === 0 ? 'Keine benutzerdefinierten Overlay-Netze.' : `${unenc.length}/${overlays.length} Overlay-Netz(e) ohne Verschlüsselung.`,
    'Overlay-Netze mit --opt encrypted anlegen, damit der Ost-West-Verkehr zwischen Nodes IPSec-verschlüsselt ist.',
    unenc));

  // INFRA-05: restart policy
  const noRestart = appServices.filter((s) => !s.Spec?.TaskTemplate?.RestartPolicy?.Condition).map(svcLabel);
  checks.push(mk('INFRA-05', 'infra', 'Services mit Restart-Policy', 'low',
    appServices.length === 0 ? 'na' : (noRestart.length === 0 ? 'pass' : 'warn'),
    `${appServices.length - noRestart.length}/${appServices.length} Service(s) mit Restart-Policy.`,
    'Restart-Policy (condition: any/on-failure) setzen, damit Tasks nach Fehlern automatisch neu gestartet werden.',
    noRestart));

  // INFRA-06: resource limits
  const noLimits = appServices.filter((s) => {
    const r = s.Spec?.TaskTemplate?.Resources?.Limits;
    return !(r && (r.MemoryBytes || r.NanoCPUs));
  }).map(svcLabel);
  checks.push(mk('INFRA-06', 'infra', 'Services mit Ressourcen-Limits', 'medium',
    appServices.length === 0 ? 'na' : (noLimits.length === 0 ? 'pass' : 'warn'),
    `${appServices.length - noLimits.length}/${appServices.length} Service(s) mit CPU/RAM-Limit.`,
    'CPU-/Memory-Limits setzen (deploy.resources.limits), damit ein Service den Node nicht erschöpft (Noisy-Neighbor/OOM-Schutz).',
    noLimits));

  // INFRA-07: healthcheck
  const noHealth = appServices.filter((s) => {
    const h = s.Spec?.TaskTemplate?.ContainerSpec?.Healthcheck;
    const test = h?.Test || [];
    return !(test.length && test[0] !== 'NONE');
  }).map(svcLabel);
  checks.push(mk('INFRA-07', 'infra', 'Services mit Healthcheck', 'medium',
    appServices.length === 0 ? 'na' : (noHealth.length === 0 ? 'pass' : 'warn'),
    `${appServices.length - noHealth.length}/${appServices.length} Service(s) mit Healthcheck.`,
    'Healthcheck definieren (HEALTHCHECK im Image oder healthcheck: in Compose), damit Swarm ungesunde Tasks erkennt und ersetzt.',
    noHealth));

  // INFRA-08: image pinning (no :latest)
  const latestImgs = appServices.filter((s) => isLatest(s.Spec?.TaskTemplate?.ContainerSpec?.Image)).map(svcLabel);
  checks.push(mk('INFRA-08', 'infra', 'Images mit fixiertem Tag/Digest', 'medium',
    appServices.length === 0 ? 'na' : (latestImgs.length === 0 ? 'pass' : 'warn'),
    latestImgs.length ? `${latestImgs.length} Service(s) nutzen :latest / kein Tag.` : 'Alle Services nutzen fixierte Tags/Digests.',
    'Konkrete Versions-Tags oder Image-Digests (@sha256:…) verwenden — :latest macht Deployments unreproduzierbar.',
    latestImgs));

  // INFRA-09: replicas > 1 for replicated
  const singleRepl = appServices.filter((s) => {
    const r = s.Spec?.Mode?.Replicated?.Replicas;
    return r != null && r === 1;
  }).map(svcLabel);
  checks.push(mk('INFRA-09', 'infra', 'Redundanz replizierter Services', 'low',
    appServices.length === 0 ? 'na' : (singleRepl.length === 0 ? 'pass' : 'warn'),
    singleRepl.length ? `${singleRepl.length} replizierte(r) Service(s) mit nur 1 Replikat.` : 'Keine Single-Replica-Services.',
    'Für zustandslose Services ≥ 2 Replikate fahren (Hochverfügbarkeit bei Node-Ausfall / rollierende Updates ohne Downtime).',
    singleRepl));

  // INFRA-10: update/rollback config
  const noUpdate = appServices.filter((s) => !s.Spec?.UpdateConfig && !s.Spec?.RollbackConfig).map(svcLabel);
  checks.push(mk('INFRA-10', 'infra', 'Update-/Rollback-Konfiguration', 'low',
    appServices.length === 0 ? 'na' : (noUpdate.length === 0 ? 'pass' : 'warn'),
    `${appServices.length - noUpdate.length}/${appServices.length} Service(s) mit Update-/Rollback-Config.`,
    'update_config/rollback_config setzen (parallelism, order: start-first, failure_action: rollback) für unterbrechungsarme Deployments.',
    noUpdate));

  // INFRA-11: named volumes instead of bind mounts
  const bindSvcs = appServices.filter((s) => (s.Spec?.TaskTemplate?.ContainerSpec?.Mounts || []).some((m) => m.Type === 'bind' && !/docker\.sock$/.test(m.Source || ''))).map(svcLabel);
  checks.push(mk('INFRA-11', 'infra', 'Named Volumes statt Bind-Mounts', 'low',
    appServices.length === 0 ? 'na' : (bindSvcs.length === 0 ? 'pass' : 'warn'),
    bindSvcs.length ? `${bindSvcs.length} Service(s) nutzen Host-Bind-Mounts.` : 'Keine Host-Bind-Mounts (außer System).',
    'Named Volumes statt Bind-Mounts verwenden (portabel, backup-/migrationsfähig, kein Node-Pfad-Zwang). Siehe Ressourcen → Bind-Mounts → Migrieren.',
    bindSvcs));

  /* ------------------------- Security ------------------------- */

  // SEC-01: docker socket mounted into containers
  const sockSvcs = appServices.filter((s) => (s.Spec?.TaskTemplate?.ContainerSpec?.Mounts || []).some((m) => /docker\.sock$/.test(m.Source || ''))).map(svcLabel);
  checks.push(mk('SEC-01', 'security', 'Kein Docker-Socket in Containern', 'high',
    appServices.length === 0 ? 'na' : (sockSvcs.length === 0 ? 'pass' : 'fail'),
    sockSvcs.length ? `${sockSvcs.length} Service(s) mounten den Docker-Socket.` : 'Kein Service mountet den Docker-Socket.',
    'Der Docker-Socket = Root auf dem Host. Nur streng notwendige, vertrauenswürdige Dienste dürfen ihn (read-only, über einen abgesicherten Socket-Proxy) einbinden.',
    sockSvcs));

  // SEC-02: privileged / CAP_SYS_ADMIN
  const privSvcs = appServices.filter((s) => {
    const cs = s.Spec?.TaskTemplate?.ContainerSpec || {};
    const caps = cs.CapabilityAdd || cs.Privileges?.CapabilityAdd || [];
    return caps.includes('CAP_SYS_ADMIN') || caps.includes('ALL');
  }).map(svcLabel);
  checks.push(mk('SEC-02', 'security', 'Keine übermäßigen Capabilities', 'high',
    appServices.length === 0 ? 'na' : (privSvcs.length === 0 ? 'pass' : 'fail'),
    privSvcs.length ? `${privSvcs.length} Service(s) mit CAP_SYS_ADMIN/ALL.` : 'Keine übermäßigen Capabilities.',
    'Nur minimal nötige Capabilities vergeben (cap_drop: ALL + gezieltes cap_add). CAP_SYS_ADMIN kommt Root/Privileged sehr nahe.',
    privSvcs));

  // SEC-03: run as root (no User set)
  const rootSvcs = appServices.filter((s) => {
    const u = s.Spec?.TaskTemplate?.ContainerSpec?.User;
    return !u || u === 'root' || u === '0';
  }).map(svcLabel);
  checks.push(mk('SEC-03', 'security', 'Container laufen nicht als root', 'medium',
    appServices.length === 0 ? 'na' : (rootSvcs.length === 0 ? 'pass' : 'warn'),
    `${appServices.length - rootSvcs.length}/${appServices.length} Service(s) mit Nicht-root-User.`,
    'Einen unprivilegierten User setzen (user: in Compose bzw. USER im Image), um die Angriffsfläche bei Container-Ausbruch zu senken.',
    rootSvcs));

  // SEC-04: no-new-privileges
  const nnpMissing = appServices.filter((s) => {
    const so = s.Spec?.TaskTemplate?.ContainerSpec?.Privileges?.SELinuxContext; // not reliable
    const opts = s.Spec?.TaskTemplate?.ContainerSpec?.Privileges?.NoNewPrivileges;
    return opts !== true;
  }).map(svcLabel);
  checks.push(mk('SEC-04', 'security', 'no-new-privileges gesetzt', 'low',
    appServices.length === 0 ? 'na' : (nnpMissing.length === 0 ? 'pass' : 'warn'),
    `${appServices.length - nnpMissing.length}/${appServices.length} Service(s) mit no-new-privileges.`,
    'security_opt: [no-new-privileges:true] setzen, damit Prozesse keine zusätzlichen Rechte per setuid erlangen können.',
    nnpMissing));

  // SEC-05: read-only rootfs
  const rwRoot = appServices.filter((s) => s.Spec?.TaskTemplate?.ContainerSpec?.ReadOnly !== true).map(svcLabel);
  checks.push(mk('SEC-05', 'security', 'Read-only Root-Dateisystem', 'low',
    appServices.length === 0 ? 'na' : (rwRoot.length === 0 ? 'pass' : 'warn'),
    `${appServices.length - rwRoot.length}/${appServices.length} Service(s) mit read-only rootfs.`,
    'read_only: true + tmpfs für Schreibpfade verwenden, wo möglich — erschwert Persistenz von Angreifern im Container.',
    rwRoot));

  // SEC-06: plaintext secrets in env
  const secretEnvRe = /(PASS|PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY)/i;
  const envSecretSvcs = appServices.filter((s) => (s.Spec?.TaskTemplate?.ContainerSpec?.Env || []).some((e) => {
    const eq = e.indexOf('='); if (eq < 0) return false;
    const k = e.slice(0, eq); const v = e.slice(eq + 1);
    return secretEnvRe.test(k) && v && v.length > 0;
  })).map(svcLabel);
  checks.push(mk('SEC-06', 'security', 'Keine Klartext-Secrets in Env-Variablen', 'high',
    appServices.length === 0 ? 'na' : (envSecretSvcs.length === 0 ? 'pass' : 'warn'),
    envSecretSvcs.length ? `${envSecretSvcs.length} Service(s) mit sensibel benannten Env-Werten.` : 'Keine offensichtlichen Klartext-Secrets in Env.',
    'Sensible Werte als Docker-Secrets bereitstellen (Env zeigt sie im Klartext in der Service-Spec). Siehe Einstellungen → Secret-Tresor.',
    envSecretSvcs));

  // SEC-07: uses swarm secrets (informational, positive)
  const usingSecrets = appServices.filter((s) => (s.Spec?.TaskTemplate?.ContainerSpec?.Secrets || []).length > 0).length;
  checks.push(mk('SEC-07', 'security', 'Nutzung von Docker-Secrets', 'info',
    secrets.length === 0 && usingSecrets === 0 ? 'na' : 'pass',
    `${secrets.length} Secret(s) definiert, von ${usingSecrets} Service(s) genutzt.`,
    'Docker-Secrets für Zugangsdaten nutzen — sie werden verschlüsselt im Raft gespeichert und nur im tmpfs des Tasks bereitgestellt.'));

  // SEC-08: daemon live-restore
  checks.push(mk('SEC-08', 'security', 'Daemon: live-restore', 'low',
    info.LiveRestoreEnabled == null ? 'na' : (info.LiveRestoreEnabled ? 'pass' : 'warn'),
    info.LiveRestoreEnabled == null ? 'Nicht ermittelbar.' : (info.LiveRestoreEnabled ? 'live-restore aktiv.' : 'live-restore inaktiv.'),
    'live-restore: true im daemon.json hält Container am Leben, wenn der Daemon neu startet (weniger Ausfall bei Docker-Updates).'));

  // SEC-09: insecure registries
  const LOOPBACK_CIDRS = new Set(['127.0.0.0/8', '::1/128']);
  const insec = (info.RegistryConfig?.InsecureRegistryCIDRs || []).filter((c) => !LOOPBACK_CIDRS.has(c));
  const insecIdx = Object.values(info.RegistryConfig?.IndexConfigs || {}).filter((i) => i.Secure === false).map((i) => i.Name);
  const insecure = [...insec, ...insecIdx];
  checks.push(mk('SEC-09', 'security', 'Keine unsicheren Registries', 'medium',
    insecure.length === 0 ? 'pass' : 'warn',
    insecure.length ? `Unsichere Registries konfiguriert: ${insecure.join(', ')}` : 'Keine unsicheren Registries.',
    'Nur TLS-gesicherte Registries verwenden; „insecure-registries" im daemon.json vermeiden (MITM-Risiko beim Pull/Push).',
    insecure));

  // Phase 2: node-local host/daemon checks (via agents). Best-effort — never
  // breaks the manager-level scan if agents are unreachable.
  try {
    const hostChecks = await runHostChecks(nodes);
    for (const c of hostChecks) checks.push(c);
  } catch { /* host checks unavailable */ }

  /* --------------------------- summary --------------------------- */
  const applicable = checks.filter((c) => c.status !== 'na');
  const pass = applicable.filter((c) => c.status === 'pass').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  const na = checks.filter((c) => c.status === 'na').length;
  const score = applicable.length ? Math.round((pass / applicable.length) * 100) : 100;
  const critical = checks.filter((c) => c.status === 'fail' && c.severity === 'high').length;
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E';

  return {
    scannedAt: new Date().toISOString(),
    summary: { total: checks.length, pass, warn, fail, na, score, grade, critical },
    checks,
  };
}

/* ==================== Phase 2: host/daemon checks ==================== */

/** Aggregate a per-node predicate into one check. evalFn(audit) -> {status,reason?}. */
function perNode(audits, id, title, severity, remediation, evalFn) {
  const results = audits.map((a) => ({ hostname: a.hostname, ...evalFn(a) }));
  const applicable = results.filter((r) => r.status !== 'na');
  const status = applicable.length === 0 ? 'na'
    : applicable.some((r) => r.status === 'fail') ? 'fail'
      : applicable.some((r) => r.status === 'warn') ? 'warn' : 'pass';
  const objects = results.filter((r) => r.status === 'warn' || r.status === 'fail')
    .map((r) => `${r.hostname}${r.reason ? `: ${r.reason}` : ''}`);
  const okN = applicable.filter((r) => r.status === 'pass').length;
  const detail = applicable.length === 0 ? 'Keine Node-Daten (Agent nicht erreichbar).' : `${okN}/${applicable.length} Node(s) ok.`;
  return { id, category: 'host', title, severity, status, detail, remediation, objects };
}

const octal = (m) => (m == null ? '?' : '0' + m.toString(8));

async function runHostChecks(nodes) {
  const ready = (nodes || []).filter((n) => n.Status?.State === 'ready');
  const audits = [];
  const unreachable = [];
  await Promise.all(ready.map(async (n) => {
    const host = n.Description?.Hostname;
    try {
      const base = await agentBaseForNode(n.ID, host);
      if (!base) { unreachable.push(host || n.ID); return; }
      const r = await fetchWithTimeout(`${base}/host-audit`, 8000);
      if (!r.ok) { unreachable.push(host || n.ID); return; }
      audits.push(await r.json());
    } catch { unreachable.push(host || n.ID); }
  }));

  const checks = [];

  // HOST-01: daemon.json permissions/owner (CIS 3.17/3.18)
  checks.push(perNode(audits, 'HOST-01', 'daemon.json Rechte & Eigentümer', 'medium',
    'daemon.json sollte root:root gehören und maximal 0644 haben (keine Schreibrechte für Gruppe/Andere).',
    (a) => {
      const f = a.files?.daemonFile;
      if (!f || !f.exists) return { status: 'na' };
      const ok = f.uid === 0 && f.gid === 0 && (f.mode & 0o022) === 0;
      return ok ? { status: 'pass' } : { status: 'fail', reason: `${octal(f.mode)} uid=${f.uid} gid=${f.gid}` };
    }));

  // HOST-02: /etc/docker directory permissions/owner (CIS 3.15/3.16)
  checks.push(perNode(audits, 'HOST-02', '/etc/docker Verzeichnis-Rechte', 'low',
    '/etc/docker sollte root:root gehören und maximal 0755 haben.',
    (a) => {
      const f = a.files?.etcDocker;
      if (!f || !f.exists) return { status: 'na' };
      const ok = f.uid === 0 && (f.mode & 0o022) === 0;
      return ok ? { status: 'pass' } : { status: 'warn', reason: `${octal(f.mode)} uid=${f.uid}` };
    }));

  // HOST-03: docker.sock permissions/owner (CIS 3.15/3.16)
  checks.push(perNode(audits, 'HOST-03', 'docker.sock Rechte & Eigentümer', 'high',
    'Der Docker-Socket sollte root:docker gehören und maximal 0660 haben; keine Rechte für „andere".',
    (a) => {
      const f = a.files?.sock;
      if (!f || !f.exists) return { status: 'na' };
      if (f.uid !== 0) return { status: 'fail', reason: `uid=${f.uid}` };
      if ((f.mode & 0o007) !== 0) return { status: 'fail', reason: `${octal(f.mode)} (Andere haben Zugriff)` };
      if ((f.mode & 0o777) > 0o660) return { status: 'warn', reason: octal(f.mode) };
      return { status: 'pass' };
    }));

  // HOST-04: auditd rules for docker (CIS 1.1.x)
  checks.push(perNode(audits, 'HOST-04', 'auditd-Regeln für Docker', 'low',
    'auditd-Regeln für dockerd, /var/lib/docker, /etc/docker, docker.service/.socket und daemon.json einrichten (Forensik/Nachvollziehbarkeit).',
    (a) => {
      const ar = a.auditRules;
      if (!ar) return { status: 'na' };
      if (!ar.present) return { status: 'warn', reason: 'keine auditd-Regeln' };
      const core = ['/usr/bin/dockerd', '/var/lib/docker', '/etc/docker'];
      const missing = core.filter((c) => !ar.covered.includes(c));
      if (missing.length === 0) return { status: 'pass' };
      return { status: 'warn', reason: `unvollständig (fehlt: ${missing.join(', ')})` };
    }));

  // HOST-05: userns-remap (CIS 2.8)
  checks.push(perNode(audits, 'HOST-05', 'User-Namespace-Remapping', 'low',
    'userns-remap aktivieren (daemon.json "userns-remap"), damit Container-root nicht Host-root ist.',
    (a) => {
      const dj = a.daemonJson || {};
      const secUserns = (a.info?.SecurityOptions || []).some((o) => /name=userns/.test(o));
      const ok = (dj['userns-remap'] && dj['userns-remap'] !== '') || secUserns;
      return ok ? { status: 'pass' } : { status: 'warn' };
    }));

  // HOST-06: no-new-privileges default (daemon-wide)
  checks.push(perNode(audits, 'HOST-06', 'Daemon: no-new-privileges Default', 'low',
    'daemon.json "no-new-privileges": true setzen, damit Prozesse keine zusätzlichen Rechte erlangen.',
    (a) => {
      const dj = a.daemonJson || {};
      return dj['no-new-privileges'] === true ? { status: 'pass' } : { status: 'warn' };
    }));

  // HOST-07: seccomp / apparmor active
  checks.push(perNode(audits, 'HOST-07', 'seccomp/AppArmor aktiv', 'medium',
    'seccomp- und AppArmor-/SELinux-Profile nicht deaktivieren (Default-seccomp-Profil beibehalten).',
    (a) => {
      const so = a.info?.SecurityOptions || [];
      const hasSeccomp = so.some((o) => /name=seccomp/.test(o));
      const seccompUnconfined = so.some((o) => /seccomp.*unconfined/i.test(o));
      const hasLsm = so.some((o) => /name=(apparmor|selinux)/.test(o));
      if (seccompUnconfined) return { status: 'warn', reason: 'seccomp: unconfined' };
      if (hasSeccomp || hasLsm) return { status: 'pass' };
      return { status: 'warn', reason: 'kein seccomp/AppArmor gemeldet' };
    }));

  // HOST-08: inter-container communication restricted (icc=false)
  checks.push(perNode(audits, 'HOST-08', 'Inter-Container-Kommunikation (icc=false)', 'low',
    'Auf dem Default-Bridge "icc": false setzen; Kommunikation gezielt über benutzerdefinierte Netze erlauben.',
    (a) => {
      const dj = a.daemonJson || {};
      return dj.icc === false ? { status: 'pass' } : { status: 'warn' };
    }));

  // HOST-09: log rotation / driver configured
  checks.push(perNode(audits, 'HOST-09', 'Log-Rotation/-Treiber konfiguriert', 'low',
    'Log-Treiber + Rotation setzen (z. B. json-file mit max-size/max-file oder journald), damit Logs nicht die Platte füllen.',
    (a) => {
      const dj = a.daemonJson || {};
      const drv = dj['log-driver'];
      const opts = dj['log-opts'] || {};
      const rotated = drv === 'journald' || drv === 'local' || (opts['max-size'] != null);
      return rotated ? { status: 'pass' } : { status: 'warn', reason: drv ? `${drv} ohne max-size` : 'Default json-file ohne Rotation' };
    }));

  // Note about unreachable nodes.
  if (unreachable.length) {
    checks.push({
      id: 'HOST-00', category: 'host', title: 'Node-Erreichbarkeit für Host-Checks', severity: 'info',
      status: 'warn', detail: `${unreachable.length} Node(s) ohne Host-Audit (Agent nicht erreichbar).`,
      remediation: 'Sicherstellen, dass der swarmdash-agent (global) auf allen Nodes läuft und /host mountet.',
      objects: unreachable,
    });
  }
  return checks;
}

