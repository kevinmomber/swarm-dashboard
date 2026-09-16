/**
 * Security / CVE scanning via Trivy.
 *
 * Runs on whichever engine imports it (dashboard→manager socket, agent→node
 * socket). A throwaway Trivy helper container scans a local image by ref, using
 * the node's Docker socket and a persistent cache volume for the vuln DB.
 */
import { docker } from './docker.js';
import { PassThrough } from 'node:stream';

const TRIVY_IMAGE = process.env.TRIVY_IMAGE || 'aquasec/trivy:latest';
const CACHE_VOL = process.env.TRIVY_CACHE_VOLUME || 'trivy-cache';
const SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';

async function pullTrivy() {
  await new Promise((resolve, reject) => {
    docker.pull(TRIVY_IMAGE, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
    });
  });
  // Verify the pull actually produced a usable image (followProgress can resolve
  // even when the final layer errored) — otherwise fail loudly here instead of
  // later at createContainer time.
  await docker.getImage(TRIVY_IMAGE).inspect();
}

/**
 * Ensure the Trivy helper image + cache volume exist. Re-validates on EVERY
 * call (a cheap local inspect) instead of trusting a stale "ready" flag — the
 * image can be removed by image-prune/cleanup between scans, which previously
 * caused intermittent "no such image" errors.
 */
export async function ensureTrivy() {
  try {
    await docker.getImage(TRIVY_IMAGE).inspect();
  } catch {
    await pullTrivy();
  }
  await docker.createVolume({ Name: CACHE_VOL }).catch(() => {});
}

/** Run `trivy image` for a ref and return the parsed JSON report. */
export async function runTrivyImage(ref) {
  if (!ref) throw new Error('image ref erforderlich');
  await ensureTrivy();

  const createTrivy = () => docker.createContainer({
    Image: TRIVY_IMAGE,
    Cmd: ['image', '--scanners', 'vuln', '--format', 'json', '--quiet', '--timeout', '10m', ref],
    HostConfig: {
      Binds: [`${SOCK}:/var/run/docker.sock`, `${CACHE_VOL}:/root/.cache`],
      AutoRemove: false,
    },
    Tty: false,
  });

  let container;
  try {
    container = await createTrivy();
  } catch (e) {
    // Race: the helper image vanished between ensureTrivy and create — pull once more and retry.
    if (/no such image/i.test(e.message || '')) {
      await pullTrivy();
      container = await createTrivy();
    } else {
      throw e;
    }
  }

  const outS = new PassThrough(); const errS = new PassThrough();
  let out = ''; let err = '';
  outS.on('data', (d) => (out += d.toString('utf8')));
  errS.on('data', (d) => (err += d.toString('utf8')));

  try {
    await container.start();
    const stream = await container.logs({ follow: true, stdout: true, stderr: true });
    docker.modem.demuxStream(stream, outS, errS);
    const res = await container.wait();
    await new Promise((r) => setTimeout(r, 120)); // let buffers flush
    if (res.StatusCode !== 0 && !out.includes('{')) {
      throw new Error((err.trim() || `Trivy exit ${res.StatusCode}`).slice(0, 300));
    }
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }

  const i = out.indexOf('{');
  const j = out.lastIndexOf('}');
  if (i < 0 || j < 0) throw new Error('Kein gültiges Trivy-JSON erhalten');
  return JSON.parse(out.slice(i, j + 1));
}

const SEV_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

/** Letter grade from severity counts. Any CRITICAL caps the grade at C. */
export function gradeFor(sev) {
  const s = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0, ...sev };
  let score = 100 - (s.CRITICAL * 25 + s.HIGH * 8 + s.MEDIUM * 2 + s.LOW * 0.3);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grades = [['A', 90], ['B', 75], ['C', 60], ['D', 40], ['E', 20]];
  let grade = 'F';
  for (const [g, min] of grades) { if (score >= min) { grade = g; break; } }
  // Caps: CRITICAL → not better than C; HIGH → not better than B.
  const rank = (g) => 'ABCDEF'.indexOf(g);
  if (s.CRITICAL > 0 && rank(grade) < rank('C')) grade = 'C';
  if (s.HIGH > 0 && rank(grade) < rank('B')) grade = 'B';
  return { grade, score };
}

/** Turn a raw Trivy report into a compact summary (counts + top CVEs). */
export function summarizeReport(report, { maxCves = 100 } = {}) {
  const severities = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  const cves = [];
  for (const r of report.Results || []) {
    for (const v of r.Vulnerabilities || []) {
      const sev = (v.Severity || 'UNKNOWN').toUpperCase();
      if (severities[sev] == null) severities[sev] = 0;
      severities[sev]++;
      cves.push({
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        installed: v.InstalledVersion,
        fixed: v.FixedVersion || null,
        severity: sev,
        title: v.Title || v.Description?.slice(0, 140) || null,
        url: v.PrimaryURL || null,
      });
    }
  }
  cves.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const total = Object.values(severities).reduce((a, b) => a + b, 0);
  const { grade, score } = gradeFor(severities);
  return {
    severities,
    total,
    grade,
    score,
    artifact: report.ArtifactName || null,
    os: report.Metadata?.OS ? `${report.Metadata.OS.Family || ''} ${report.Metadata.OS.Name || ''}`.trim() : null,
    cves: cves.slice(0, maxCves),
    truncated: cves.length > maxCves,
  };
}

/** Scan an image ref locally and return the summary. */
export async function scanImageLocal(ref, opts) {
  const report = await runTrivyImage(ref);
  return summarizeReport(report, opts);
}

export { SEV_ORDER };
