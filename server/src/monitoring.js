import mqtt from 'mqtt';
import nodemailer from 'nodemailer';
import { docker, requireManager } from './docker.js';
import { agentMetrics } from './metrics.js';
import { loadSettings, saveSettings, appendMonitorLog, MONITOR_LABEL } from './settings.js';
import { getCaStatus, listCerts } from './pki.js';
import { inventory } from './endpoints.js';

const daysUntil = (iso) => (iso ? Math.floor((new Date(iso).getTime() - Date.now()) / 86400000) : null);

let timer = null;
let mqttClient = null;
let mqttKey = '';
const prevStates = new Map(); // target -> { healthy, message }
let lastSnapshot = { at: null, nodes: [], services: [] };

const pct = (used, total) => (total ? Math.round((used / total) * 100) : null);

/* --------------------------- MQTT lifecycle ------------------------ */

function ensureMqtt(cfg) {
  const key = cfg.enabled ? `${cfg.url}|${cfg.username}` : '';
  if (key === mqttKey) return;
  if (mqttClient) { try { mqttClient.end(true); } catch { /* noop */ } mqttClient = null; }
  mqttKey = key;
  if (!cfg.enabled || !cfg.url) return;
  try {
    mqttClient = mqtt.connect(cfg.url, {
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      reconnectPeriod: 10000,
      connectTimeout: 8000,
    });
    mqttClient.on('error', (e) => console.warn('MQTT-Fehler:', e.message));
  } catch (e) {
    console.warn('MQTT-Verbindung fehlgeschlagen:', e.message);
  }
}
function mqttPublish(topic, payload, retain = true) {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { retain });
  }
}

/* ---------------------------- dispatchers -------------------------- */

async function sendWebhook(cfg, alert) {
  if (!cfg.enabled || !cfg.url) return;
  await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alert) }).catch(() => {});
}
async function sendMatrix(cfg, alert) {
  if (!cfg.enabled || !cfg.homeserver || !cfg.accessToken || !cfg.roomId) return;
  const txn = Date.now();
  const url = `${cfg.homeserver.replace(/\/$/, '')}/_matrix/client/v3/rooms/${encodeURIComponent(cfg.roomId)}/send/m.room.message/${txn}?access_token=${encodeURIComponent(cfg.accessToken)}`;
  await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'm.text', body: `[${alert.level}] ${alert.target}: ${alert.message}` }) }).catch(() => {});
}
async function sendEmail(cfg, alert) {
  if (!cfg.enabled || !cfg.host || !cfg.to) return;
  try {
    const transport = nodemailer.createTransport({
      host: cfg.host, port: Number(cfg.port) || 587, secure: Boolean(cfg.secure),
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    });
    await transport.sendMail({
      from: cfg.from || cfg.user, to: cfg.to,
      subject: `[Swarm ${alert.level}] ${alert.target}`,
      text: `${alert.message}\n\nZeit: ${alert.at}`,
    });
  } catch (e) { console.warn('E-Mail-Alert fehlgeschlagen:', e.message); }
}

async function dispatch(level, target, message) {
  const settings = await loadSettings();
  const alerts = settings.monitoring.alerts;
  const alert = { level, target, message, at: new Date().toISOString() };

  await Promise.all([
    sendWebhook(alerts.webhook, alert),
    sendMatrix(alerts.matrix, alert),
    sendEmail(alerts.email, alert),
  ]);
  mqttPublish(`${alerts.mqtt.topicPrefix || 'swarmdash'}/alerts`, alert, false);

  appendMonitorLog(settings, alert);
  await saveSettings(settings);
}

/** Transition-aware: only alert on healthy<->unhealthy changes. */
async function evaluate(target, healthy, message) {
  const prev = prevStates.get(target);
  prevStates.set(target, { healthy, message });
  if (!prev) { if (!healthy) await dispatch('alert', target, message); return; }
  if (prev.healthy && !healthy) await dispatch('alert', target, message);
  else if (!prev.healthy && healthy) await dispatch('recovery', target, 'Wieder normal');
}

/* ------------------------------ checks ----------------------------- */

async function runChecks() {
  const settings = await loadSettings();
  const mon = settings.monitoring;
  if (!mon.enabled) return;
  ensureMqtt(mon.alerts.mqtt);
  const prefix = mon.alerts.mqtt.topicPrefix || 'swarmdash';

  const snapshot = { at: new Date().toISOString(), nodes: [], services: [], certs: [], endpoints: [] };

  // --- Nodes ---
  try {
    const [nodes, agents] = await Promise.all([docker.listNodes(), agentMetrics()]);
    for (const n of nodes) {
      const host = n.Description?.Hostname;
      const live = agents[n.ID] || agents[`h:${host}`] || null;
      const issues = [];
      if (n.Status?.State !== 'ready') issues.push(`Status ${n.Status?.State}`);
      let cpu = null, mem = null, disk = null;
      if (live) {
        cpu = live.cpu?.loadPct; mem = pct(live.mem?.used, live.mem?.total); disk = pct(live.disk?.used, live.disk?.total);
        if (cpu != null && cpu >= mon.thresholds.cpu) issues.push(`CPU ${cpu}%`);
        if (mem != null && mem >= mon.thresholds.mem) issues.push(`RAM ${mem}%`);
        if (disk != null && disk >= mon.thresholds.disk) issues.push(`Disk ${disk}%`);
      }
      const healthy = issues.length === 0;
      snapshot.nodes.push({ host, healthy, cpu, mem, disk, state: n.Status?.State, issues });
      await evaluate(`node:${host}`, healthy, issues.join(', '));
      if (mon.mqttStatus) mqttPublish(`${prefix}/node/${host}/status`, { cpu, mem, disk, state: n.Status?.State, healthy });
    }
  } catch (e) { console.warn('Node-Check fehlgeschlagen:', e.message); }

  // --- Services (tagged swarmdash.monitor=<serviceTag>) ---
  try {
    const [services, tasks] = await Promise.all([docker.listServices(), docker.listTasks()]);
    const running = new Map();
    for (const t of tasks) if (t.Status?.State === 'running') running.set(t.ServiceID, (running.get(t.ServiceID) || 0) + 1);
    for (const s of services) {
      const tag = s.Spec?.Labels?.[MONITOR_LABEL];
      if (!tag) continue;
      if (mon.serviceTag && tag !== mon.serviceTag) continue;
      const desired = s.Spec?.Mode?.Replicated?.Replicas ?? null;
      const run = running.get(s.ID) || 0;
      const healthy = desired == null || run >= desired;
      snapshot.services.push({ name: s.Spec.Name, healthy, running: run, desired });
      await evaluate(`service:${s.Spec.Name}`, healthy, `${run}/${desired} Repliken laufen`);
      if (mon.mqttStatus) mqttPublish(`${prefix}/service/${s.Spec.Name}/status`, { running: run, desired, healthy });
    }
  } catch (e) { console.warn('Service-Check fehlgeschlagen:', e.message); }

  // --- PKI certificate expiry (proactive) ---
  if (mon.checkCertExpiry) {
    try {
      const limit = Number(mon.certExpiryDays) || 30;
      const items = [];
      const ca = await getCaStatus();
      if (ca?.exists && ca.notAfter) items.push({ name: `CA · ${ca.cn}`, notAfter: ca.notAfter });
      for (const c of await listCerts()) {
        if (c.status === 'revoked') continue;
        if (c.notAfter) items.push({ name: c.cn, notAfter: c.notAfter });
      }
      for (const it of items) {
        const d = daysUntil(it.notAfter);
        const healthy = d == null || d > limit;
        snapshot.certs.push({ name: it.name, days: d, healthy });
        await evaluate(`cert:${it.name}`, healthy, d < 0 ? 'Zertifikat abgelaufen' : `Zertifikat läuft in ${d} Tagen ab`);
      }
    } catch (e) { console.warn('Cert-Check fehlgeschlagen:', e.message); }
  }

  // --- Registered Docker endpoints reachable? ---
  if (mon.checkEndpoints) {
    try {
      const inv = await inventory();
      for (const ep of inv) {
        if (ep.builtin) continue; // local endpoint is the dashboard itself
        snapshot.endpoints.push({ name: ep.name, healthy: ep.reachable });
        await evaluate(`endpoint:${ep.name}`, ep.reachable, ep.error || 'Endpoint nicht erreichbar');
        if (mon.mqttStatus) mqttPublish(`${prefix}/endpoint/${ep.name}/status`, { reachable: ep.reachable });
      }
    } catch (e) { console.warn('Endpoint-Check fehlgeschlagen:', e.message); }
  }

  const allHealthy = snapshot.nodes.every((n) => n.healthy) && snapshot.services.every((s) => s.healthy)
    && snapshot.certs.every((c) => c.healthy) && snapshot.endpoints.every((e) => e.healthy);
  if (mon.mqttStatus) mqttPublish(`${prefix}/health`, { healthy: allHealthy, at: snapshot.at });
  lastSnapshot = snapshot;
}

/* --------------------------- public API ---------------------------- */

export async function applyMonitoring() {
  const settings = await loadSettings();
  const mon = settings.monitoring;
  if (timer) { clearInterval(timer); timer = null; }
  ensureMqtt(mon.alerts.mqtt);
  if (!mon.enabled) return { running: false };
  const interval = Math.max(15, Number(mon.intervalSec) || 60) * 1000;
  timer = setInterval(() => { runChecks().catch((e) => console.error('Monitoring-Lauf:', e.message)); }, interval);
  runChecks().catch(() => {});
  return { running: true, intervalSec: interval / 1000 };
}

export async function getStatus() {
  const settings = await loadSettings();
  return {
    enabled: settings.monitoring.enabled,
    lastRun: lastSnapshot.at,
    nodes: lastSnapshot.nodes,
    services: lastSnapshot.services,
    certs: lastSnapshot.certs || [],
    endpoints: lastSnapshot.endpoints || [],
    mqttConnected: Boolean(mqttClient && mqttClient.connected),
    log: (settings.monitorLog || []).slice(-100).reverse(),
  };
}

export async function testAlert() {
  await requireManager().catch(() => {});
  await dispatch('test', 'monitoring', 'Test-Benachrichtigung vom Swarm Dashboard');
  return { ok: true };
}
