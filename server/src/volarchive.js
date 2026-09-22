/**
 * Volume content transfer via Docker's archive API (equivalent to `docker cp`).
 *
 * A throwaway helper container mounts the volume at MOUNT; getArchive/putArchive
 * then stream the volume's contents as a tar. Works on a *created* (not started)
 * container, so no image entrypoint runs. Used both by the dashboard (manager
 * socket) and by the node agent (local socket) — each operating on its own engine.
 */
import { docker } from './docker.js';
import { ensureImage, resolveHelperImage, runEphemeral } from './ephemeral.js';

const MOUNT = '/vol';

async function helperFor(volumeName, ro) {
  const image = await ensureImage();
  return docker.createContainer({
    Image: image,
    Cmd: ['true'],
    Entrypoint: [''], // neutralize the dashboard image's ENTRYPOINT (node)
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

/** Extract a tar stream (entries prefixed "vol/") into volumeName (created if needed).
 * With { clean: true } the volume's existing contents are wiped first. */
export async function importVolume(volumeName, tarStream, { clean = false } = {}) {
  await docker.createVolume({ Name: volumeName }).catch(() => {});
  if (clean) {
    // Empty the volume's current contents before restoring (node-local wipe).
    await ensureImage();
    await runEphemeral(
      [`${volumeName}:${MOUNT}`],
      `find ${MOUNT} -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; true`,
    ).catch(() => {});
  }
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

/**
 * Disk pre-flight probe for a bind→volume migration, run ON THE NODE that will
 * host the new volume. Mounts the bind source read-only and a throwaway probe
 * volume, then reports:
 *  - sizeBytes: apparent size of the bind data (du) — how much the new volume needs
 *  - storeFreeBytes / storeTotalBytes: free/total space on the filesystem where
 *    Docker actually stores volumes (df of the probe volume's mountpoint)
 * The probe volume lives in the same storage as the future volume, so df is
 * accurate even when Docker's data-root is on a separate partition from host /.
 */
export async function migrationDiskProbe(bindSource) {
  if (!bindSource || !bindSource.startsWith('/')) throw new Error('Ungültiger Bind-Quellpfad');
  await ensureImage();
  const probeVol = `swarmdash_probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  await docker.createVolume({ Name: probeVol }).catch(() => {});
  try {
    const script =
      'SZ=$(du -sk /src 2>/dev/null | tail -n1 | cut -f1); ' +
      'DF=$(df -Pk /store 2>/dev/null | tail -n1); ' +
      `echo "SIZE_KB=$SZ"; echo "DF=$DF"`;
    const { output } = await runEphemeral([`${bindSource}:/src:ro`, `${probeVol}:/store`], script);
    let sizeBytes = null; let storeTotalBytes = null; let storeFreeBytes = null; let mountpoint = null;
    for (const line of (output || '').split('\n').map((l) => l.trim())) {
      const mSz = line.match(/^SIZE_KB=(\d+)/);
      if (mSz) sizeBytes = parseInt(mSz[1], 10) * 1024;
      const mDf = line.match(/^DF=(.+)/);
      if (mDf) {
        // df -Pk: Filesystem 1024-blocks Used Available Capacity Mounted-on
        const parts = mDf[1].trim().split(/\s+/);
        if (parts.length >= 6) {
          const total = parseInt(parts[1], 10);
          const avail = parseInt(parts[3], 10);
          if (Number.isFinite(total)) storeTotalBytes = total * 1024;
          if (Number.isFinite(avail)) storeFreeBytes = avail * 1024;
          mountpoint = parts.slice(5).join(' ');
        }
      }
    }
    return { sizeBytes, storeTotalBytes, storeFreeBytes, mountpoint };
  } finally {
    await docker.getVolume(probeVol).remove().catch(() => {});
  }
}
