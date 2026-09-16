/**
 * Volume content transfer via Docker's archive API (equivalent to `docker cp`).
 *
 * A throwaway helper container mounts the volume at MOUNT; getArchive/putArchive
 * then stream the volume's contents as a tar. Works on a *created* (not started)
 * container, so no image entrypoint runs. Used both by the dashboard (manager
 * socket) and by the node agent (local socket) — each operating on its own engine.
 */
import { docker } from './docker.js';
import { ensureImage, HELPER_IMAGE, runEphemeral } from './ephemeral.js';

const MOUNT = '/vol';

async function helperFor(volumeName, ro) {
  await ensureImage();
  return docker.createContainer({
    Image: HELPER_IMAGE,
    Cmd: ['true'],
    HostConfig: { Binds: [`${volumeName}:${MOUNT}${ro ? ':ro' : ''}`] },
  });
}

/** Readable tar stream of a volume's contents (tar entries are prefixed "vol/"). */
export async function exportVolume(volumeName) {
  const c = await helperFor(volumeName, true);
  let stream;
  try {
    stream = await c.getArchive({ path: MOUNT });
  } catch (e) {
    await c.remove({ force: true }).catch(() => {});
    throw e;
  }
  const cleanup = () => c.remove({ force: true }).catch(() => {});
  stream.once('end', cleanup);
  stream.once('close', cleanup);
  stream.once('error', cleanup);
  return stream;
}

/** Extract a tar stream (entries prefixed "vol/") into volumeName (created if needed). */
export async function importVolume(volumeName, tarStream) {
  await docker.createVolume({ Name: volumeName }).catch(() => {});
  const c = await helperFor(volumeName, false);
  try {
    // The tar's top-level dir is "vol/", so extracting at "/" lands the content
    // back inside the mounted volume at /vol.
    await c.putArchive(tarStream, { path: '/' });
    return { ok: true };
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

/** Best-effort apparent size (bytes) of a volume's contents, for progress totals. */
export async function volumeSize(volumeName) {
  await ensureImage();
  const { output } = await runEphemeral(
    [`${volumeName}:${MOUNT}:ro`],
    `du -sk ${MOUNT} 2>/dev/null | tail -n1 | cut -f1`,
  );
  const kb = parseInt((output || '').trim(), 10);
  return Number.isFinite(kb) ? kb * 1024 : null;
}
