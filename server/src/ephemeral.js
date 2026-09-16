import { docker } from './docker.js';

export const HELPER_IMAGE = 'alpine:latest';

let imageReady = false;

/** Ensure the helper image is present (pull once). */
export async function ensureImage(image = HELPER_IMAGE) {
  if (imageReady && image === HELPER_IMAGE) return;
  try {
    await docker.getImage(image).inspect();
  } catch {
    await new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
      });
    });
  }
  if (image === HELPER_IMAGE) imageReady = true;
}

/**
 * Run a throwaway alpine container and capture its combined output.
 * @param {string[]} binds  Docker HostConfig.Binds entries
 * @param {string}   script sh -c script to run
 * @returns {Promise<{code:number, output:string}>}
 */
export async function runEphemeral(binds, script, opts = {}) {
  const container = await docker.createContainer({
    Image: HELPER_IMAGE,
    Cmd: ['sh', '-c', script],
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
