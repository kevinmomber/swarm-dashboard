import { createRequire } from 'node:module';
import { docker, requireManager } from './docker.js';
import { authConfigFor } from './registryauth.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const VERSION = pkg.version;
export const CREATOR = process.env.DASHBOARD_CREATOR || pkg.author || 'unbekannt';
const SELF_SERVICE = process.env.SELF_SERVICE || 'swarmdash_dashboard';

async function findSelfService() {
  const services = await docker.listServices();
  return (
    services.find((s) => s.Spec?.Name === SELF_SERVICE) ||
    services.find((s) => /dashboard/i.test(s.Spec?.Name || '')) ||
    null
  );
}

export async function systemInfo() {
  const info = await docker.info().catch(() => ({}));
  let image = null;
  let service = null;
  try {
    await requireManager();
    const svc = await findSelfService();
    if (svc) {
      service = svc.Spec.Name;
      image = (svc.Spec?.TaskTemplate?.ContainerSpec?.Image || '').split('@')[0] || null;
    }
  } catch { /* not a manager */ }
  return {
    version: VERSION,
    creator: CREATOR,
    image,
    service,
    node: info.Name || null,
    dockerVersion: info.ServerVersion || null,
  };
}

function pullImage(ref) {
  return new Promise((resolve, reject) => {
    authConfigFor(ref).then((authconfig) => {
      const cb = (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
      };
      if (authconfig) docker.pull(ref, { authconfig }, cb);
      else docker.pull(ref, cb);
    }).catch(reject);
  });
}

/** Pull the current image tag and compare its digest with the running one. */
export async function checkUpdate() {
  await requireManager();
  const svc = await findSelfService();
  if (!svc) throw Object.assign(new Error('Eigener Dashboard-Service nicht gefunden'), { status: 409 });
  const deployed = svc.Spec.TaskTemplate.ContainerSpec.Image; // repo:tag@sha256:...
  const tag = deployed.split('@')[0];
  const currentDigest = deployed.includes('@') ? deployed.split('@')[1] : null;

  try {
    await pullImage(tag);
  } catch (e) {
    return { updateAvailable: false, tag, note: `Kein Abgleich möglich (Pull fehlgeschlagen: ${e.message}). Bei lokal gebauten Images ohne Registry erwartet.` };
  }
  const inspected = await docker.getImage(tag).inspect();
  const latestDigest = (inspected.RepoDigests && inspected.RepoDigests[0]) ? inspected.RepoDigests[0].split('@')[1] : inspected.Id;
  return {
    tag,
    currentDigest,
    latestDigest,
    updateAvailable: Boolean(currentDigest) && currentDigest !== latestDigest,
  };
}

/** Force the dashboard service to re-pull its image tag and roll (start-first). */
export async function selfUpdate() {
  await requireManager();
  const svc = await findSelfService();
  if (!svc) throw Object.assign(new Error('Eigener Dashboard-Service nicht gefunden'), { status: 409 });
  const service = docker.getService(svc.ID);
  const info = await service.inspect();
  const spec = structuredClone(info.Spec);
  // reset any pinned digest so the tag is re-resolved to the newest image
  spec.TaskTemplate.ContainerSpec.Image = spec.TaskTemplate.ContainerSpec.Image.split('@')[0];
  spec.TaskTemplate.ForceUpdate = (spec.TaskTemplate.ForceUpdate || 0) + 1;
  await service.update({ version: info.Version.Index, ...spec });
  return { ok: true, service: svc.Spec.Name, image: spec.TaskTemplate.ContainerSpec.Image };
}
