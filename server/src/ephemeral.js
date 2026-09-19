import { docker } from './docker.js';

/**
 * Helper image used for throwaway "mount a volume and read/copy it" containers
 * (volume duplicate/rename/export/import/size).
 *
 * PROBLEM in production: the old default `alpine:latest` had to be pulled on
 * every node. That fails with HTTP 401 (Docker Hub rate limit / a private
 * registry mirror requiring auth) or simply "image not found" on nodes without
 * it — breaking volume duplication.
 *
 * FIX: prefer an image that is ALREADY present on every swarm node. The
 * dashboard's own image (`swarm-dashboard:latest`) runs on every node (the
 * agent is a global service) and is node:22-alpine based, so it ships busybox
 * (`sh`, `du`, `cp`, `tar`, `true`) — everything the helpers need. We resolve to
 * the first locally-present candidate and NEVER pull unless nothing is found.
 */

// Configurable primary (defaults to the dashboard's own, always-present image).
const PRIMARY = process.env.HELPER_IMAGE || 'swarm-dashboard:latest';
// Ordered candidates tried by local presence before any network pull.
const CANDIDATES = [
  PRIMARY,
  'swarm-dashboard:latest',
  'alpine:latest',
  'alpine:3.20',
  'busybox:latest',
];

let resolved = null; // cached resolved image ref

async function isLocal(image) {
  try { await docker.getImage(image).inspect(); return true; } catch { return false; }
}

/**
 * Resolve a helper image that exists locally (no pull). Falls back to pulling
 * alpine only if truly nothing suitable is present.
 */
export async function resolveHelperImage() {
  if (resolved) return resolved;
  for (const img of CANDIDATES) {
    if (await isLocal(img)) { resolved = img; return resolved; }
  }
  // Last resort: pull alpine (may 401 on locked-down clusters — hence the
  // preference for the already-present self-image above).
  const fallback = 'alpine:latest';
  await new Promise((res, rej) => {
    docker.pull(fallback, (err, stream) => {
      if (err) return rej(new Error(`Kein lokales Helfer-Image gefunden und Pull von ${fallback} schlug fehl: ${err.message}`));
      docker.modem.followProgress(stream, (e) => (e ? rej(e) : res()));
    });
  });
  resolved = fallback;
  return resolved;
}

// Back-compat export; callers may read this after ensureImage().
export let HELPER_IMAGE = PRIMARY;

/** Ensure a usable helper image is available; returns the resolved ref. */
export async function ensureImage() {
  const img = await resolveHelperImage();
  HELPER_IMAGE = img;
  return img;
}

/**
 * Run a throwaway helper container and capture its combined output.
 * @param {string[]} binds  Docker HostConfig.Binds entries
 * @param {string}   script sh -c script to run
 * @returns {Promise<{code:number, output:string}>}
 */
export async function runEphemeral(binds, script, opts = {}) {
  const image = await resolveHelperImage();
  const container = await docker.createContainer({
    Image: image,
    Cmd: ['sh', '-c', script],
    Entrypoint: [''], // neutralize the dashboard image's ENTRYPOINT/CMD (node)
    HostConfig: { Binds: binds, AutoRemove: false, ...(opts.HostConfig || {}) },
    Tty: true, // raw output — avoids multiplexed log frame headers
  });
  try {
    await container.start();
    const res = await container.wait();
    const logBuf = await container.logs({ stdout: true, stderr: true });
    const output = Buffer.isBuffer(logBuf)
      ? logBuf.toString('utf8').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '')
      : String(logBuf);
    return { code: res.StatusCode, output: output.trim() };
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}
