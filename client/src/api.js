const JSON_HEADERS = { 'Content-Type': 'application/json' };
const TOKEN_KEY = 'swarmdash.token';

// Deployment base prefix injected by the server (empty at site root, e.g.
// '/swarmdash' when Traefik serves this app under a stripped sub-path). All
// absolute /api and /ws URLs are prefixed with it so they route correctly.
const BASE = (typeof window !== 'undefined' && window.__BASE_PREFIX__) || '';
const apiUrl = (path) => `${BASE}/api${path}`;

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function handle(res) {
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event('swarmdash-unauth'));
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

export const api = {
  get: (path) => fetch(apiUrl(path), { headers: { ...authHeaders() } }).then(handle),
  getText: (path) => fetch(apiUrl(path), { headers: { ...authHeaders() } }).then(async (res) => {
    if (res.status === 401) { setToken(null); window.dispatchEvent(new Event('swarmdash-unauth')); }
    const text = await res.text();
    if (!res.ok) { try { throw new Error(JSON.parse(text)?.error || `HTTP ${res.status}`); } catch { throw new Error(`HTTP ${res.status}`); } }
    return text;
  }),
  post: (path, body) =>
    fetch(apiUrl(path), {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...authHeaders() },
      body: JSON.stringify(body || {}),
    }).then(handle),
  put: (path, body) =>
    fetch(apiUrl(path), {
      method: 'PUT',
      headers: { ...JSON_HEADERS, ...authHeaders() },
      body: JSON.stringify(body || {}),
    }).then(handle),
  del: (path) => fetch(apiUrl(path), { method: 'DELETE', headers: { ...authHeaders() } }).then(handle),
};

/** POST that consumes a Server-Sent-Events response, invoking onEvent per event. */
export async function postSSE(path, body, onEvent) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...authHeaders() },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) { setToken(null); window.dispatchEvent(new Event('swarmdash-unauth')); }
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try { const t = await res.text(); const d = t ? JSON.parse(t) : null; if (d?.error) msg = d.error; } catch { /* noop */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* ignore malformed */ }
    }
  }
}

/** Trigger a browser download from base64 data (e.g. a PKCS#12 bundle). */
export function downloadBase64(dataB64, filename, mime = 'application/octet-stream') {
  const bin = atob(dataB64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([buf], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function wsToken() {
  const t = getToken();
  return t ? `&token=${encodeURIComponent(t)}` : '';
}

export function logSocket(serviceId, tail = 200) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(
    `${proto}://${location.host}${BASE}/ws/logs?service=${encodeURIComponent(serviceId)}&tail=${tail}${wsToken()}`
  );
}

export function execSocket(serviceId, shell = '/bin/sh') {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(
    `${proto}://${location.host}${BASE}/ws/exec?service=${encodeURIComponent(serviceId)}&shell=${encodeURIComponent(shell)}${wsToken()}`
  );
}

export function eventSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(`${proto}://${location.host}${BASE}/ws/events?${wsToken().replace(/^&/, '')}`);
}
