/**
 * Lightweight time-series store for node metrics (CPU/RAM/disk).
 *
 * A background sampler writes one row per node every SAMPLE_MS into a SQLite
 * DB; old rows beyond RETENTION_HOURS are pruned. The Nodes/Dashboard UI reads
 * back a downsampled series to draw sparklines/charts. Uses Node's built-in
 * node:sqlite (no native dependency), same as the PKI store.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DATA_DIR } from './settings.js';
import { agentMetrics, connectedNodeStats } from './metrics.js';
import { docker } from './docker.js';

const DB_PATH = path.join(DATA_DIR, 'metrics.db');
const SAMPLE_MS = 60_000;      // one sample per node per minute
const RETENTION_HOURS = 48;    // keep two days
const pct = (used, total) => (total ? Math.round((used / total) * 100) : null);

let db = null;
let timer = null;

function getDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS samples (
    ts INTEGER NOT NULL,
    node TEXT NOT NULL,
    cpu INTEGER, mem INTEGER, disk INTEGER
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_samples_node ON samples(node, ts)');
  return db;
}

async function sample() {
  try {
    const d = getDb();
    const now = Date.now();
    const rows = [];
    const [nodes, agents] = await Promise.all([
      docker.listNodes().catch(() => []),
      agentMetrics().catch(() => ({})),
    ]);
    if (nodes.length) {
      for (const n of nodes) {
        const host = n.Description?.Hostname;
        const live = agents[n.ID] || agents[`h:${host}`] || null;
        if (!live) continue;
        rows.push([now, host, live.cpu?.loadPct ?? null, pct(live.mem?.used, live.mem?.total), pct(live.disk?.used, live.disk?.total)]);
      }
    }
    // Fallback: connected node probe when no agent data is available.
    if (rows.length === 0) {
      const s = await connectedNodeStats().catch(() => null);
      if (s && !s.error) rows.push([now, s.hostname || 'local', s.cpu?.loadPct ?? null, pct(s.mem?.used, s.mem?.total), pct(s.disk?.used, s.disk?.total)]);
    }
    const ins = d.prepare('INSERT INTO samples (ts, node, cpu, mem, disk) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(...r);
    // Prune old rows.
    d.prepare('DELETE FROM samples WHERE ts < ?').run(now - RETENTION_HOURS * 3600_000);
  } catch (e) {
    console.warn('Metrik-Sampling fehlgeschlagen:', e.message);
  }
}

export function startMetricsSampler() {
  if (timer) return;
  sample();
  timer = setInterval(sample, SAMPLE_MS);
  if (timer.unref) timer.unref();
}

/** Return per-node series for the last `hours`, optionally downsampled to ~maxPoints. */
export function history({ hours = 6, maxPoints = 120 } = {}) {
  const d = getDb();
  const since = Date.now() - Math.max(1, Math.min(48, hours)) * 3600_000;
  const rows = d.prepare('SELECT ts, node, cpu, mem, disk FROM samples WHERE ts >= ? ORDER BY ts ASC').all(since);
  const byNode = new Map();
  for (const r of rows) {
    if (!byNode.has(r.node)) byNode.set(r.node, []);
    byNode.get(r.node).push(r);
  }
  const out = [];
  for (const [node, series] of byNode) {
    let pts = series;
    if (series.length > maxPoints) {
      const step = Math.ceil(series.length / maxPoints);
      pts = series.filter((_, i) => i % step === 0);
    }
    out.push({
      node,
      points: pts.map((p) => ({ t: p.ts, cpu: p.cpu, mem: p.mem, disk: p.disk })),
    });
  }
  return { hours, nodes: out };
}
