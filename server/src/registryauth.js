import { loadSettings } from './settings.js';

/** Extract the registry host from an image reference (defaults to docker.io). */
export function registryHost(ref) {
  const path = (ref || '').replace(/^https?:\/\//, '');
  const first = path.indexOf('/');
  if (first === -1) return 'docker.io';
  const maybe = path.slice(0, first);
  if (maybe.includes('.') || maybe.includes(':') || maybe === 'localhost') return maybe;
  return 'docker.io';
}

/** Return a dockerode authconfig for the registry matching an image ref, or null. */
export async function authConfigFor(imageRef) {
  const settings = await loadSettings();
  const host = registryHost(imageRef);
  const norm = (u) => (u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const reg = (settings.registries || []).find((r) => r.url && (norm(r.url) === host || norm(r.url) === norm(host)));
  if (!reg || !reg.username) return null;
  return { username: reg.username, password: reg.password || '', serveraddress: reg.url };
}
