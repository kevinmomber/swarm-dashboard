/**
 * In-memory store for the latest Security (CVE) scan results, keyed by
 * `${nodeId}|${ref}`. Persists for the lifetime of the dashboard process so the
 * Security page loads instantly and only re-scans on demand.
 */
import { gradeFor } from './security.js';

const results = new Map(); // key -> { nodeId, node, ref, scannedAt, summary|error }

const keyOf = (nodeId, ref) => `${nodeId || ''}|${ref}`;

export function putResult(nodeId, node, ref, data) {
  results.set(keyOf(nodeId, ref), { nodeId, node, ref, scannedAt: new Date().toISOString(), ...data });
}

export function getResult(nodeId, ref) {
  return results.get(keyOf(nodeId, ref)) || null;
}

export function allResults() {
  return [...results.values()];
}

export function clearResults() {
  results.clear();
}

/** Aggregate a scorecard across all cached (successful) results. */
export function scorecard() {
  const totals = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  let scanned = 0; let failed = 0; let worstRank = -1; let worstGrade = null;
  const rank = (g) => 'ABCDEF'.indexOf(g);
  for (const r of results.values()) {
    if (r.error) { failed++; continue; }
    if (!r.severities) continue;
    scanned++;
    for (const k of Object.keys(totals)) totals[k] += r.severities[k] || 0;
    if (r.grade && rank(r.grade) > worstRank) { worstRank = rank(r.grade); worstGrade = r.grade; }
  }
  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  const { score } = gradeFor(totals);
  return { totals, total, scanned, failed, grade: worstGrade || (scanned ? 'A' : null), score };
}
