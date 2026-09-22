/**
 * Best-Practice-Scanner Phase 3: Verlauf (Score-Historie), Zeitplan (Scheduler)
 * und Alert-Integration.
 *
 * - Jeder (geplante oder manuelle) Best-Practice-Lauf wird als eine Zeile in einer
 *   SQLite-DB persistiert (Score, Grade, Zähler + eine kompakte JSON-Liste der
 *   kritischen/fehlgeschlagenen Findings zum Diffen).
 * - Ein optionaler Hintergrund-Scheduler führt runBestPractices() in einem
 *   konfigurierbaren Intervall aus, schreibt den Lauf in die Historie und meldet
 *   NEU aufgetretene kritische Findings (bzw. eine Grade-Verschlechterung) über die
 *   bestehende Monitoring-Alert-Pipeline.
 *
 * Nutzt Node's eingebautes node:sqlite (keine native Abhängigkeit), wie metricshistory/pki.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DATA_DIR } from './settings.js';
import { loadSettings } from './settings.js';
import { runBestPractices } from './bestpractices.js';
import { dispatchAlert } from './monitoring.js';

const DB_PATH = path.join(DATA_DIR, 'bestpractices.db');
const RETENTION_DAYS = 180; // halbes Jahr Historie behalten

let db = null;
let timer = null;
let lastRun = null; // in-memory Kopie des letzten Laufs (Summary + scannedAt)

function getDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    ts INTEGER NOT NULL,
    total INTEGER, pass INTEGER, warn INTEGER, fail INTEGER, na INTEGER,
    score INTEGER, grade TEXT, critical INTEGER,
    trigger TEXT,
    findings TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_bp_runs_ts ON runs(ts)');
  return db;
}

/** Kompakte, diff-taugliche Liste der kritischen/fehlgeschlagenen Findings eines Laufs. */
function criticalFindings(result) {
  return (result.checks || [])
    .filter((c) => c.status === 'fail' && (c.severity === 'high' || c.severity === 'medium'))
    .map((c) => ({ id: c.id, title: c.title, severity: c.severity, category: c.category }));
}

function lastFindingsIds() {
  const d = getDb();
  const row = d.prepare('SELECT findings FROM runs ORDER BY ts DESC LIMIT 1').get();
  if (!row || !row.findings) return new Set();
  try { return new Set(JSON.parse(row.findings).map((f) => f.id)); } catch { return new Set(); }
}

function lastGrade() {
  const d = getDb();
  const row = d.prepare('SELECT grade FROM runs ORDER BY ts DESC LIMIT 1').get();
  return row?.grade || null;
}

/**
 * Persistiert einen Lauf. Liefert die im Vergleich zum Vorlauf NEU aufgetretenen
 * kritischen Findings sowie eine etwaige Grade-Verschlechterung.
 */
export function recordRun(result, trigger = 'manual') {
  const d = getDb();
  const s = result.summary || {};
  const findings = criticalFindings(result);
  const prevIds = lastFindingsIds();
  const prevGrade = lastGrade();
  const now = Date.now();

  d.prepare(`INSERT INTO runs (ts, total, pass, warn, fail, na, score, grade, critical, trigger, findings)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    now, s.total ?? null, s.pass ?? null, s.warn ?? null, s.fail ?? null, s.na ?? null,
    s.score ?? null, s.grade ?? null, s.critical ?? null, trigger, JSON.stringify(findings),
  );
  d.prepare('DELETE FROM runs WHERE ts < ?').run(now - RETENTION_DAYS * 86400_000);

  lastRun = { scannedAt: new Date(now).toISOString(), summary: s, trigger };

  const rank = (g) => 'ABCDEF'.indexOf(g || 'A');
  const newCritical = findings.filter((f) => !prevIds.has(f.id));
  const gradeDropped = prevGrade != null && rank(s.grade) > rank(prevGrade);
  return { newCritical, gradeDropped, prevGrade, grade: s.grade || null };
}

/** Zeitreihe der letzten `days` Tage (jeder Lauf = ein Punkt). */
export function history({ days = 30, maxPoints = 200 } = {}) {
  const d = getDb();
  const since = Date.now() - Math.max(1, Math.min(RETENTION_DAYS, days)) * 86400_000;
  const rows = d.prepare(
    'SELECT ts, total, pass, warn, fail, na, score, grade, critical, trigger FROM runs WHERE ts >= ? ORDER BY ts ASC',
  ).all(since);
  let pts = rows;
  if (rows.length > maxPoints) {
    const step = Math.ceil(rows.length / maxPoints);
    pts = rows.filter((_, i) => i % step === 0);
  }
  return {
    days,
    points: pts.map((r) => ({
      t: r.ts, score: r.score, grade: r.grade, critical: r.critical,
      pass: r.pass, warn: r.warn, fail: r.fail, na: r.na, total: r.total, trigger: r.trigger,
    })),
  };
}

export function latestRun() { return lastRun; }

/* ------------------------------- Scheduler ------------------------------- */

/** Einen Lauf ausführen, persistieren und ggf. Alerts auslösen. */
async function runAndRecord(trigger = 'schedule') {
  const settings = await loadSettings();
  const cfg = settings.bestPractices || {};
  const result = await runBestPractices();
  const diff = recordRun(result, trigger);

  try {
    if (cfg.alertOnNewCritical !== false && diff.newCritical.length) {
      const list = diff.newCritical.map((f) => `${f.id} ${f.title}`).join('; ');
      await dispatchAlert('alert', 'best-practices',
        `${diff.newCritical.length} neue kritische Best-Practice-Findings: ${list}`);
    }
    if (cfg.alertOnGradeDrop && diff.gradeDropped) {
      await dispatchAlert('alert', 'best-practices',
        `Best-Practice-Note verschlechtert: ${diff.prevGrade} → ${diff.grade}`);
    }
  } catch (e) { console.warn('Best-Practice-Alert fehlgeschlagen:', e.message); }

  return { result, diff };
}

/** Manuell einen Lauf auslösen und in die Historie schreiben (für UI „Neu prüfen"). */
export async function runNow() {
  const { result } = await runAndRecord('manual');
  return result;
}

/** Scheduler gemäß Settings (neu) starten. Idempotent. */
export async function applyBestPracticeSchedule() {
  const settings = await loadSettings();
  const cfg = settings.bestPractices || {};
  if (timer) { clearInterval(timer); timer = null; }
  if (!cfg.enabled) return { running: false };
  const hours = Math.max(1, Math.min(168, Number(cfg.intervalHours) || 24));
  const ms = hours * 3600_000;
  timer = setInterval(() => {
    runAndRecord('schedule').catch((e) => console.error('Best-Practice-Lauf:', e.message));
  }, ms);
  if (timer.unref) timer.unref();
  // Einmal verzögert nach dem Start (Agents brauchen ~20-30s bis Discovery greift).
  setTimeout(() => { runAndRecord('schedule').catch(() => {}); }, 30_000);
  return { running: true, intervalHours: hours };
}

export function scheduleStatus() {
  return { running: Boolean(timer), lastRun };
}
