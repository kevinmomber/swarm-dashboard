import cron from 'node-cron';
import { docker, requireManager } from './docker.js';
import { ensureImage, runEphemeral } from './ephemeral.js';
import { volumeDuplicate, volumeSizeOnNode, localNodeId } from './cluster.js';
import {
  loadSettings,
  saveSettings,
  appendHistory,
  BACKUP_LABEL,
  BACKUP_VOLUMES_LABEL,
} from './settings.js';

/* ------------------------------------------------------------------ */
/* Discovery                                                          */
/* ------------------------------------------------------------------ */

/**
 * Services opted-in via label swarmdash.backup=<tag>, with their named volumes.
 * Each volume is annotated with the nodeId where the service's task runs — the
 * data physically lives on that node, so the backup must read it there (not on
 * the manager, which would otherwise mount an empty auto-created volume).
 * @param {string} [tag] restrict to services whose backup label equals this value.
 */
export async function listBackupServices(tag) {
  await requireManager();
  const [services, tasks] = await Promise.all([
    docker.listServices(),
    docker.listTasks().catch(() => []),
  ]);

  // service id -> nodeId (prefer a running task, else any task with a node).
  const nodeByService = new Map();
  for (const t of tasks) {
    if (t.ServiceID && t.NodeID && t.Status?.State === 'running' && !nodeByService.has(t.ServiceID)) {
      nodeByService.set(t.ServiceID, t.NodeID);
    }
  }
  for (const t of tasks) {
    if (t.ServiceID && t.NodeID && !nodeByService.has(t.ServiceID)) {
      nodeByService.set(t.ServiceID, t.NodeID);
    }
  }

  const result = [];
  for (const s of services) {
    const labels = s.Spec?.Labels || {};
    const val = labels[BACKUP_LABEL];
    if (!val || val === 'false' || val === '0') continue;
    if (tag != null && val !== tag) continue;

    const nodeId = nodeByService.get(s.ID) || null;
    const mounts = s.Spec?.TaskTemplate?.ContainerSpec?.Mounts || [];
    let volumes = mounts
      .filter((m) => (m.Type === 'volume' || m.Type === 'bind') && m.Source)
      .map((m) => {
        if (m.Type === 'bind') {
          const id = `bind-${Buffer.from(m.Source).toString('base64url')}`;
          return { name: id, source: m.Source, target: m.Target, type: 'bind', label: m.Source, nodeId };
        }
        return { name: m.Source, source: m.Source, target: m.Target, type: 'volume', label: m.Source, nodeId };
      });

    const only = labels[BACKUP_VOLUMES_LABEL];
    if (only) {
      const set = new Set(only.split(',').map((x) => x.trim()).filter(Boolean));
      // match against volume name / bind source path
      volumes = volumes.filter((v) => set.has(v.source) || set.has(v.name) || set.has(v.label));
    }

    result.push({
      id: s.ID,
      name: s.Spec.Name,
      stack: labels['com.docker.stack.namespace'] || null,
      tag: val,
      nodeId,
      volumes,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Target preparation                                                 */
/* ------------------------------------------------------------------ */

async function createSmbVolume(smb) {
  const name = `swarmdash_smb_${Date.now()}`;
  const device = `//${smb.host}/${smb.share}`;
  const opts = [
    `username=${smb.username || 'guest'}`,
    `password=${smb.password || ''}`,
    `vers=${smb.version || '3.0'}`,
  ];
  if (smb.domain) opts.push(`domain=${smb.domain}`);
  await docker.createVolume({
    Name: name,
    Driver: 'local',
    DriverOpts: { type: 'cifs', device, o: opts.join(',') },
  });
  return { name, cleanup: () => docker.getVolume(name).remove().catch(() => {}) };
}

/** Resolve a target into a bind spec ("source:/target") + subdir + cleanup. */
async function prepareTarget(target, { withPassword } = {}) {
  if (target.type === 'smb') {
    const smb = { ...(target.smb || {}) };
    if (withPassword && !smb.password) smb.password = withPassword;
    if (!smb.host || !smb.share) {
      throw new Error('SMB-Ziel unvollständig: host und share erforderlich');
    }
    const vol = await createSmbVolume(smb);
    return {
      bind: `${vol.name}:/target`,
      sub: smb.subPath ? `/${smb.subPath.replace(/^\/+/, '')}` : '',
      cleanup: vol.cleanup,
    };
  }
  const p = target.localPath;
  if (!p) throw new Error('Lokaler Pfad fehlt');
  return { bind: `${p}:/target`, sub: '', cleanup: async () => {} };
}

const ts = () =>
  new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/* ------------------------------------------------------------------ */
/* Target inspection / test                                           */
/* ------------------------------------------------------------------ */

export async function testTarget(targetOverride) {
  await requireManager();
  const settings = await loadSettings();
  let target = targetOverride || settings.backup.target;
  const storedPw = settings.backup.target?.smb?.password || '';
  await ensureImage();
  const { bind, sub, cleanup } = await prepareTarget(target, { withPassword: storedPw });
  try {
    const script = `set -e; DIR="/target${sub}"; mkdir -p "$DIR"; T="$DIR/.swarmdash_write_test"; echo ok > "$T"; cat "$T"; rm -f "$T"`;
    const { code, output } = await runEphemeral([bind], script);
    if (code !== 0) throw new Error(output || `Exit ${code}`);
    return { ok: true, message: 'Ziel ist beschreibbar' };
  } finally {
    await cleanup();
  }
}

/** List archives present in the target, grouped by volume name. */
export async function listArchives() {
  await requireManager();
  const settings = await loadSettings();
  const storedPw = settings.backup.target?.smb?.password || '';
  await ensureImage();
  const { bind, sub, cleanup } = await prepareTarget(settings.backup.target, { withPassword: storedPw });
  try {
    const script = `DIR="/target${sub}"; cd "$DIR" 2>/dev/null || exit 0; for f in *.tar.gz; do [ -e "$f" ] || continue; printf '%s\\t%s\\n' "$f" "$(stat -c %s "$f")"; done`;
    const { output } = await runEphemeral([bind], script);
    const byVol = {};
    for (const line of output.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [file, size] = line.split('\t');
      const m = file.match(/^(.*)-\d{8}-\d{6}\.tar\.gz$/);
      const vol = m ? m[1] : file;
      (byVol[vol] = byVol[vol] || []).push({ file, bytes: parseInt(size, 10) || 0 });
    }
    for (const v of Object.keys(byVol)) byVol[v].sort((a, b) => b.file.localeCompare(a.file));

    // Resolve which node each volume currently belongs to (for display + default
    // restore target) and map node ids to hostnames.
    const services = await listBackupServices().catch(() => []);
    const nodeByVol = new Map();
    for (const svc of services) for (const v of svc.volumes) if (!nodeByVol.has(v.name)) nodeByVol.set(v.name, v.nodeId || null);
    const hostById = new Map();
    try { for (const n of await docker.listNodes()) hostById.set(n.ID, n.Description?.Hostname || null); } catch { /* ignore */ }

    // Decorate with a friendly label + type (bind sources are base64url-encoded).
    const out = {};
    for (const [key, list] of Object.entries(byVol)) {
      let label = key, type = 'volume';
      if (key.startsWith('bind-')) {
        type = 'bind';
        try { label = Buffer.from(key.slice(5), 'base64url').toString('utf8'); } catch { label = key; }
      }
      const nId = nodeByVol.get(key) || null;
      out[key] = { type, label, nodeId: nId, hostname: nId ? (hostById.get(nId) || null) : null, archives: list };
    }
    return out;
  } finally {
    await cleanup();
  }
}

/** Resolve the node a backed-up volume currently belongs to (via tagged services). */
async function resolveVolumeNode(volumeName) {
  try {
    const services = await listBackupServices();
    for (const svc of services) {
      for (const v of svc.volumes) {
        if (v.name === volumeName) return v.nodeId || null;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** Restore a single archive back into its named volume or bind path.
 * Node-aware: a named volume is restored onto the node it currently belongs to
 * (auto-resolved from the tagged services, or an explicit nodeId override). */
export async function restoreArchive({ volume, file, clean, nodeId }) {
  await requireManager();
  if (!volume || !file) throw new Error('volume und file erforderlich');
  if (!/^[\w.-]+$/.test(volume) || !/^[\w.-]+\.tar\.gz$/.test(file)) {
    throw new Error('Ungültiger Volume- oder Dateiname');
  }
  const settings = await loadSettings();
  const storedPw = settings.backup.target?.smb?.password || '';
  await ensureImage();

  const localId = await localNodeId();
  const isBind = volume.startsWith('bind-');
  // Target node: explicit override wins, else auto-resolve from tagged services.
  const targetNode = nodeId || (isBind ? null : await resolveVolumeNode(volume));
  const remote = targetNode && localId && targetNode !== localId;

  // --- Remote named volume: extract on the manager into a temp volume, then
  //     push it onto the target node (with optional clean wipe). ---
  if (remote) {
    if (isBind) throw new Error('Bind-Mount-Restore auf einen Remote-Node wird nicht unterstützt (nur Named Volumes)');
    const tmp = `swarmdash_rsttmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { bind, sub, cleanup } = await prepareTarget(settings.backup.target, { withPassword: storedPw });
    try {
      await docker.createVolume({ Name: tmp }).catch(() => {});
      const script =
        `set -e; SRC="/target${sub}/${file}"; [ -f "$SRC" ] || { echo "Archiv nicht gefunden"; exit 2; }; ` +
        `find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; ` +
        `tar xzf "$SRC" -C /data ; echo extracted`;
      const { code, output } = await runEphemeral([`${tmp}:/data`, bind], script);
      if (code !== 0) throw new Error(output || `Exit ${code}`);
      // Push temp volume's contents to the real volume on the target node.
      await volumeDuplicate({ srcNodeId: localId, name: tmp, dstNodeId: targetNode, newName: volume, clean: Boolean(clean) });
      return { ok: true, volume, file, node: targetNode };
    } finally {
      await cleanup();
      await docker.getVolume(tmp).remove().catch(() => {});
    }
  }

  // --- Local (manager) volume or bind: extract directly on the manager. ---
  let destMount;
  if (isBind) {
    let path;
    try { path = Buffer.from(volume.slice(5), 'base64url').toString('utf8'); } catch { throw new Error('Ungültiger Bind-Bezeichner'); }
    if (!path.startsWith('/')) throw new Error('Bind-Pfad ungültig');
    destMount = `${path}:/data`;
  } else {
    await docker.createVolume({ Name: volume }).catch(() => {});
    destMount = `${volume}:/data`;
  }

  const { bind, sub, cleanup } = await prepareTarget(settings.backup.target, { withPassword: storedPw });
  try {
    const wipe = clean ? 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + ;' : '';
    const script =
      `set -e; SRC="/target${sub}/${file}"; [ -f "$SRC" ] || { echo "Archiv nicht gefunden"; exit 2; }; ` +
      `${wipe} tar xzf "$SRC" -C /data ; echo restored`;
    const { code, output } = await runEphemeral([destMount, bind], script);
    if (code !== 0) throw new Error(output || `Exit ${code}`);
    return { ok: true, volume, file, node: targetNode || localId };
  } finally {
    await cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* Backup run                                                         */
/* ------------------------------------------------------------------ */

let running = false;

export async function runBackup({ jobId = 'default', trigger = 'manual', onProgress } = {}) {
  if (running) throw new Error('Ein Backup läuft bereits');
  running = true;
  const emit = (ev) => { try { onProgress?.(ev); } catch { /* ignore listener errors */ } };
  const started = new Date();
  const settings0 = await loadSettings();
  const job = (settings0.backup.jobs || []).find((j) => j.id === jobId);
  if (!job) {
    running = false;
    throw new Error(`Backup-Job "${jobId}" nicht gefunden`);
  }

  const entry = {
    id: `bk_${started.getTime()}`,
    jobId: job.id,
    jobName: job.name,
    trigger,
    startedAt: started.toISOString(),
    finishedAt: null,
    status: 'running',
    volumes: [],
    error: null,
  };

  let cleanup = async () => {};
  try {
    await ensureImage();
    const localId = await localNodeId();
    const services = await listBackupServices(job.tag);
    const volMap = new Map(); // name -> { name, source, type, label, nodeId }
    for (const svc of services) {
      for (const v of svc.volumes) {
        if (!volMap.has(v.name)) volMap.set(v.name, v);
      }
    }
    if (volMap.size === 0) {
      throw new Error(`Keine Services mit Label ${BACKUP_LABEL}=${job.tag} und Volumes/Bind-Mounts gefunden`);
    }

    const storedPw = settings0.backup.target?.smb?.password || '';
    const prepared = await prepareTarget(settings0.backup.target, { withPassword: storedPw });
    cleanup = prepared.cleanup;
    const keep = Math.max(1, Number(job.retention) || 7);
    const stamp = ts();

    const planned = [...volMap.values()].map((v) => ({ name: v.name, label: v.label || v.name, type: v.type || 'volume' }));
    emit({ type: 'plan', jobName: job.name, total: planned.length, volumes: planned });

    let index = 0;
    for (const vol of volMap.values()) {
      index += 1;
      const remote = vol.nodeId && localId && vol.nodeId !== localId;
      const rec = {
        name: vol.name, label: vol.label || vol.name, type: vol.type || 'volume',
        nodeId: vol.nodeId || localId, file: null, bytes: 0, sourceBytes: null, ok: false, error: null,
      };
      emit({ type: 'volume', phase: 'start', index, total: planned.length, name: vol.name, label: rec.label, remote: Boolean(remote) });
      let tmpVol = null;
      try {
        // The archive helper runs on the MANAGER and mounts the source by name.
        // For a volume that physically lives on another node, the manager has no
        // such volume — Docker would auto-create an EMPTY one → a byte-sized
        // archive wrongly reported as success. So for remote volumes we first
        // copy the data to a temp volume on the manager (verified cross-node
        // path), then archive that. Bind mounts can't be copied this way.
        let mountSource = vol.source;
        if (remote) {
          if (vol.type === 'bind') {
            throw new Error(`Bind-Mount „${vol.label}" liegt auf Remote-Node und wird für Backups derzeit nicht unterstützt (nur Named Volumes)`);
          }
          emit({ type: 'volume', phase: 'copy', index, total: planned.length, name: vol.name, label: rec.label });
          tmpVol = `swarmdash_bktmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
          await volumeDuplicate({
            srcNodeId: vol.nodeId, name: vol.source, dstNodeId: localId, newName: tmpVol,
            onBytes: (b) => emit({ type: 'volume', phase: 'copy-progress', index, total: planned.length, name: vol.name, bytes: b }),
          });
          mountSource = tmpVol;
        }

        // Node-aware apparent source size — used both as info and as a guard.
        const srcBytes = await volumeSizeOnNode(vol.nodeId, vol.source).catch(() => null);
        rec.sourceBytes = srcBytes;
        emit({ type: 'volume', phase: 'archive', index, total: planned.length, name: vol.name, label: rec.label, sourceBytes: srcBytes });

        const file = `${vol.name}-${stamp}.tar.gz`;
        const script =
          `set -e; DIR="/target${prepared.sub}"; mkdir -p "$DIR"; ` +
          `tar czf "$DIR/${file}" -C /data . ; ` +
          `ls -1t "$DIR/${vol.name}-"*.tar.gz 2>/dev/null | tail -n +${keep + 1} | xargs -r rm -f ; ` +
          `stat -c %s "$DIR/${file}"`;
        const { code, output } = await runEphemeral([`${mountSource}:/data:ro`, prepared.bind], script);
        if (code !== 0) throw new Error(output || `Exit ${code}`);
        const bytes = parseInt(output.split('\n').pop().trim(), 10);
        const finalBytes = Number.isFinite(bytes) ? bytes : 0;

        // Guard: source clearly has content (>1 MB) but archive is empty-tar sized
        // (~86 B). This catches any residual "empty volume" situation instead of
        // silently recording a useless backup as success.
        if (srcBytes != null && srcBytes > 1048576 && finalBytes < 512) {
          throw new Error(`Archiv verdächtig leer (${finalBytes} B) obwohl die Quelle ~${Math.round(srcBytes / 1048576)} MB enthält — Backup als fehlgeschlagen markiert`);
        }

        rec.file = file;
        rec.bytes = finalBytes;
        rec.ok = true;
      } catch (e) {
        rec.error = e.message;
      } finally {
        if (tmpVol) await docker.getVolume(tmpVol).remove().catch(() => {});
      }
      emit({ type: 'volume', phase: 'done', index, total: planned.length, name: vol.name, label: rec.label, ok: rec.ok, bytes: rec.bytes, error: rec.error });
      entry.volumes.push(rec);
    }
    const failed = entry.volumes.filter((v) => !v.ok).length;
    entry.status = failed === 0 ? 'success' : entry.volumes.some((v) => v.ok) ? 'partial' : 'failed';
  } catch (e) {
    entry.status = 'failed';
    entry.error = e.message;
  } finally {
    await cleanup();
    entry.finishedAt = new Date().toISOString();
    const settings = await loadSettings();
    appendHistory(settings, entry);
    await saveSettings(settings);
    running = false;
  }
  return entry;
}

export function isRunning() {
  return running;
}

/* ------------------------------------------------------------------ */
/* Scheduler (one cron task per enabled job)                          */
/* ------------------------------------------------------------------ */

const tasks = new Map();

export async function applySchedule() {
  const settings = await loadSettings();
  for (const t of tasks.values()) t.stop();
  tasks.clear();

  const scheduled = [];
  for (const job of settings.backup.jobs || []) {
    if (!job.enabled) continue;
    if (!cron.validate(job.schedule)) {
      console.warn(`Job "${job.name}": ungültiger Cron "${job.schedule}" — übersprungen`);
      continue;
    }
    const task = cron.schedule(job.schedule, () => {
      runBackup({ jobId: job.id, trigger: 'schedule' }).catch((e) =>
        console.error(`Geplantes Backup (${job.name}) fehlgeschlagen:`, e.message)
      );
    });
    tasks.set(job.id, task);
    scheduled.push({ id: job.id, schedule: job.schedule });
  }
  if (scheduled.length) console.log(`Backup-Scheduler aktiv für ${scheduled.length} Job(s)`);
  return { scheduled };
}
