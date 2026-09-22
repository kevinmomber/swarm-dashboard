import { useState, useMemo, useEffect } from 'react';
import { api, postSSE } from '../api.js';
import { useApi } from '../components/useApi.js';
import { Badge, Modal, bytes, ago, useToast } from '../components/ui.jsx';
import TabBar from '../components/TabBar.jsx';
import PkiPanel from '../components/PkiPanel.jsx';

const SEVS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const SEV_LABEL = { CRITICAL: 'Kritisch', HIGH: 'Hoch', MEDIUM: 'Mittel', LOW: 'Niedrig', UNKNOWN: 'Unbekannt' };
const sevColor = (s) => ({
  CRITICAL: '#d0333f', HIGH: '#e8833a', MEDIUM: '#d2a91f', LOW: '#3b82f6', UNKNOWN: '#8b949e',
}[s] || '#8b949e');
const gradeColor = (g) => ({ A: '#2ea043', B: '#7bc043', C: '#d2a91f', D: '#e8833a', E: '#e8833a', F: '#d0333f' }[g] || '#8b949e');

function GradeBadge({ grade, size = 44 }) {
  if (!grade) return <span className="help">–</span>;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, borderRadius: '50%', fontWeight: 800, fontSize: size * 0.42,
      color: '#fff', background: gradeColor(grade),
    }}>{grade}</span>
  );
}

function SevPills({ sev, compact }) {
  if (!sev) return <span className="help">–</span>;
  const shown = SEVS.filter((s) => (sev[s] || 0) > 0 || (!compact && s !== 'UNKNOWN'));
  if (shown.length === 0) return <Badge kind="ok">clean</Badge>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {shown.map((s) => (
        <span key={s} title={SEV_LABEL[s]} style={{
          fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
          color: '#fff', background: sevColor(s), opacity: (sev[s] || 0) ? 1 : 0.35,
        }}>{s[0]} {sev[s] || 0}</span>
      ))}
    </span>
  );
}

function CveModal({ target, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [sevFilter, setSevFilter] = useState('all');

  useMemo(() => {
    api.get(`/security/result?nodeId=${encodeURIComponent(target.nodeId || '')}&ref=${encodeURIComponent(target.ref)}`)
      .then(setData).catch((e) => setErr(e.message));
  }, [target.nodeId, target.ref]);

  const cves = (data?.cves || []).filter((c) =>
    (sevFilter === 'all' || c.severity === sevFilter)
    && (!q || `${c.id} ${c.pkg} ${c.title || ''}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <Modal title={`CVEs · ${target.ref}`} onClose={onClose} wide
      footer={<button className="btn" onClick={onClose}>Schließen</button>}>
      {err && <div className="banner">{err}</div>}
      {!data && !err && <div className="help">Lade Ergebnis…</div>}
      {data && data.error && <div className="banner">Scan-Fehler: {data.error}</div>}
      {data && !data.error && (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <GradeBadge grade={data.grade} size={36} />
            <SevPills sev={data.severities} />
            <span className="help">{data.os || ''} · {data.total} Funde{data.truncated ? ' (Top 100)' : ''}</span>
            <div className="spacer" style={{ flex: 1 }} />
            <input style={{ maxWidth: 220 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 CVE / Paket…" />
            <select value={sevFilter} onChange={(e) => setSevFilter(e.target.value)} style={{ width: 130 }}>
              <option value="all">Alle</option>
              {SEVS.map((s) => <option key={s} value={s}>{SEV_LABEL[s]}</option>)}
            </select>
          </div>
          <div className="table-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
            <table>
              <thead><tr><th>CVE</th><th>Schwere</th><th>Paket</th><th>Installiert</th><th>Fix</th><th>Titel</th></tr></thead>
              <tbody>
                {cves.length === 0 && <tr><td colSpan={6} className="empty" style={{ padding: 16 }}>Keine Treffer.</td></tr>}
                {cves.map((c, i) => (
                  <tr key={`${c.id}/${c.pkg}/${i}`}>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.id}</a> : c.id}
                    </td>
                    <td><span style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 10, color: '#fff', background: sevColor(c.severity) }}>{c.severity}</span></td>
                    <td className="mono" style={{ fontSize: 12 }}>{c.pkg}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{c.installed}</td>
                    <td className="mono" style={{ fontSize: 12, color: c.fixed ? 'var(--green)' : 'var(--text-dim)' }}>{c.fixed || '—'}</td>
                    <td style={{ fontSize: 12 }}>{c.title || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function Vulnerability() {
  const { data, error, loading, reload } = useApi('/security');
  const toast = useToast();
  const [scanning, setScanning] = useState(false);
  const [prog, setProg] = useState(null); // { done, total, current }
  const [q, setQ] = useState('');
  const [node, setNode] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all'); // all | scanned | unscanned | vuln | clean
  const [cveTarget, setCveTarget] = useState(null);

  const targets = data?.targets || [];
  const card = data?.scorecard || null;
  const nodes = [...new Set(targets.map((t) => t.node).filter(Boolean))].sort();

  const rows = targets
    .filter((t) => node === 'all' || t.node === node)
    .filter((t) => {
      if (statusFilter === 'scanned') return t.result && !t.result.error;
      if (statusFilter === 'unscanned') return !t.result;
      if (statusFilter === 'vuln') return t.result && !t.result.error && (t.result.total || 0) > 0;
      if (statusFilter === 'clean') return t.result && !t.result.error && (t.result.total || 0) === 0;
      return true;
    })
    .filter((t) => !q || t.ref.toLowerCase().includes(q.toLowerCase()) || (t.repoTags || []).some((x) => x.toLowerCase().includes(q.toLowerCase())));

  const runScan = async (list, label) => {
    setScanning(true);
    setProg({ done: 0, total: list.length, current: '' });
    try {
      await postSSE('/security/scan', { targets: list.map((t) => ({ nodeId: t.nodeId, ref: t.ref, node: t.node })) }, (e) => {
        if (e.type === 'start') setProg({ done: 0, total: e.total, current: '' });
        else if (e.type === 'scanning') setProg((p) => ({ ...(p || {}), current: e.ref, done: e.done, total: e.total }));
        else if (e.type === 'progress') setProg((p) => ({ ...(p || {}), done: e.done, total: e.total }));
        else if (e.type === 'error') toast(e.message, 'err');
      });
      toast(`Scan abgeschlossen (${label})`, 'ok');
      reload();
    } catch (e) { toast(e.message, 'err'); } finally { setScanning(false); setProg(null); }
  };

  const scanAll = () => runScan(targets.filter((t) => !t.dangling), 'alle Images');
  const scanOne = (t) => runScan([t], t.ref);

  return (
    <>
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div className="sub">CVE-Scan aller Images (Trivy) mit Score-Bewertung</div>
        <div className="actions">
          <button className="btn" disabled={scanning} onClick={reload}>↻ Aktualisieren</button>
          <button className="btn primary" disabled={scanning || targets.length === 0} onClick={scanAll}>
            {scanning ? 'Scanne…' : '🛡 Alle scannen'}
          </button>
        </div>
      </div>

      {card && (
        <div className="grid cols-3" style={{ marginBottom: 16 }}>
          <div className="card stat" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <GradeBadge grade={card.grade} size={56} />
            <div>
              <div className="label">Gesamt-Bewertung</div>
              <div className="value" style={{ fontSize: 22 }}>{card.grade || '–'} <small>Score {card.score}</small></div>
              <div className="help">{card.scanned} gescannt{card.failed ? ` · ${card.failed} Fehler` : ''}</div>
            </div>
          </div>
          <div className="card stat">
            <div className="label">Gefundene Schwachstellen</div>
            <div className="value" style={{ fontSize: 24 }}>{card.total}</div>
            <div style={{ marginTop: 8 }}><SevPills sev={card.totals} compact /></div>
          </div>
          <div className="card stat">
            <div className="label">Abdeckung</div>
            <div className="value" style={{ fontSize: 24 }}>{card.scanned} / {targets.length}</div>
            <div className="help">Images gescannt</div>
          </div>
        </div>
      )}

      {prog && (
        <div style={{ marginBottom: 16 }}>
          <div className="help" style={{ marginBottom: 4 }}>
            Scanne {prog.done} / {prog.total}{prog.current ? ` · aktuell: ${prog.current}` : ''}
          </div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-elev2)', overflow: 'hidden' }}>
            <div style={{ width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%`, height: '100%', background: 'var(--accent)', transition: 'width .25s' }} />
          </div>
        </div>
      )}

      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <input style={{ maxWidth: 260 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Image nach Name filtern…" />
        {q && <button className="btn sm" onClick={() => setQ('')}>✕</button>}
        <label style={{ margin: '0 0 0 6px' }}>Node:</label>
        <select style={{ width: 160 }} value={node} onChange={(e) => setNode(e.target.value)}>
          <option value="all">Alle Nodes</option>
          {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <label style={{ margin: '0 0 0 6px' }}>Status:</label>
        <select style={{ width: 170 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">Alle</option>
          <option value="scanned">Gescannt</option>
          <option value="unscanned">Nicht gescannt</option>
          <option value="vuln">Mit Funden</option>
          <option value="clean">Ohne Funde</option>
        </select>
      </div>

      {error && <div className="banner">{error}</div>}
      {loading && !data && <div className="spinner">Lade Images…</div>}
      {data && rows.length === 0 && <div className="empty">Keine Images gefunden.</div>}

      {rows.length > 0 && (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 720 }}>
            <thead>
              <tr><th>Bewertung</th><th>Image</th><th>Node</th><th>Verwendung</th><th>Schwachstellen</th><th>Status</th><th>Aktion</th></tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const r = t.result;
                return (
                  <tr key={`${t.nodeId}|${t.ref}`}>
                    <td>{r && !r.error ? <GradeBadge grade={r.grade} size={34} /> : <span className="help">–</span>}</td>
                    <td>
                      <div className="mono" style={{ fontSize: 12, fontWeight: 600, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.ref}>{t.ref}</div>
                      <div className="help" style={{ fontSize: 10 }}>{bytes(t.size)}{t.dangling ? ' · dangling' : ''}{t.inUse ? ' · in Verwendung' : ''}</div>
                    </td>
                    <td><Badge kind="muted">{t.node}</Badge></td>
                    <td>
                      {t.usedBy.length
                        ? <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', maxWidth: 220 }}>{t.usedBy.slice(0, 3).map((u, i) => <Badge key={i} kind="info">{u.name}</Badge>)}{t.usedBy.length > 3 ? <span className="help">+{t.usedBy.length - 3}</span> : null}</span>
                        : <span className="help">–</span>}
                    </td>
                    <td>{r && !r.error ? <SevPills sev={r.severities} compact /> : <span className="help">–</span>}</td>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {!r && <span className="help">nicht gescannt</span>}
                      {r && r.error && <Badge kind="err">Fehler</Badge>}
                      {r && !r.error && <span style={{ color: 'var(--text-dim)' }}>{ago(r.scannedAt)}</span>}
                    </td>
                    <td>
                      <div className="actions" style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn sm" disabled={scanning} onClick={() => scanOne(t)}>Scannen</button>
                        {r && !r.error && <button className="btn sm" onClick={() => setCveTarget(t)}>Details</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {cveTarget && <CveModal target={cveTarget} onClose={() => setCveTarget(null)} />}
    </>
  );
}

function Sparkline({ points, width = 260, height = 40 }) {
  if (!points || points.length < 2) return <span className="help">Noch keine Verlaufsdaten</span>;
  const xs = points.map((_, i) => i);
  const maxX = xs[xs.length - 1] || 1;
  const path = points.map((p, i) => {
    const x = (i / maxX) * (width - 4) + 2;
    const y = height - 2 - ((p.score ?? 0) / 100) * (height - 4);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = points[points.length - 1];
  const col = last.score >= 80 ? 'var(--ok,#3fb950)' : last.score >= 50 ? 'var(--warn,#d29922)' : 'var(--err,#f85149)';
  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      <line x1="2" y1={height - 2 - 0.8 * (height - 4)} x2={width - 2} y2={height - 2 - 0.8 * (height - 4)} stroke="var(--border,#30363d)" strokeDasharray="3 3" />
      <path d={path} fill="none" stroke={col} strokeWidth="2" />
      {points.map((p, i) => {
        const x = (i / maxX) * (width - 4) + 2;
        const y = height - 2 - ((p.score ?? 0) / 100) * (height - 4);
        return <circle key={i} cx={x} cy={y} r="1.6" fill={col}><title>{`${new Date(p.t).toLocaleString()}: ${p.score}% (${p.grade})`}</title></circle>;
      })}
    </svg>
  );
}

function BestPractices() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all'); // all | infra | security | host | issues
  const [err, setErr] = useState(null);
  const [hist, setHist] = useState(null);
  const [sched, setSched] = useState(null);
  const [savingSched, setSavingSched] = useState(false);

  const loadHist = async () => { try { setHist(await api.get('/security/best-practices/history?days=30')); } catch { /* noop */ } };
  const loadSched = async () => { try { setSched(await api.get('/security/best-practices/schedule')); } catch { /* noop */ } };

  // Display-only load (no history entry) on first mount.
  const load = async () => {
    setBusy(true); setErr(null);
    try { setData(await api.get('/security/best-practices')); }
    catch (e) { setErr(e.message); toast(e.message, 'err'); } finally { setBusy(false); }
  };
  // Manual re-check that records into the score history.
  const run = async () => {
    setBusy(true); setErr(null);
    try { setData(await api.post('/security/best-practices/run')); await loadHist(); }
    catch (e) { setErr(e.message); toast(e.message, 'err'); } finally { setBusy(false); }
  };
  useEffect(() => { load(); loadHist(); loadSched(); }, []);

  const saveSched = async (patch) => {
    setSavingSched(true);
    try {
      const cfg = { ...(sched?.config || {}), ...patch };
      setSched(await api.post('/security/best-practices/schedule', cfg));
      toast('Zeitplan gespeichert', 'ok');
    } catch (e) { toast(e.message, 'err'); } finally { setSavingSched(false); }
  };

  const sevBadge = (sev) => {
    const map = { high: 'err', medium: 'warn', low: 'info', info: 'muted' };
    const lbl = { high: 'Hoch', medium: 'Mittel', low: 'Niedrig', info: 'Info' };
    return <Badge kind={map[sev] || 'muted'}>{lbl[sev] || sev}</Badge>;
  };
  const statusBadge = (st) => {
    if (st === 'pass') return <Badge kind="ok">OK</Badge>;
    if (st === 'warn') return <Badge kind="warn">Warnung</Badge>;
    if (st === 'fail') return <Badge kind="err">Fehler</Badge>;
    return <Badge kind="muted">n/a</Badge>;
  };

  const checks = data?.checks || [];
  const shown = checks.filter((c) => {
    if (filter === 'all') return true;
    if (filter === 'issues') return c.status === 'warn' || c.status === 'fail';
    return c.category === filter;
  });
  const s = data?.summary;

  return (
    <>
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <div className="sub">Read-only Best-Practice-Prüfung des Swarm-Managers (Infrastruktur & Security)</div>
        <button className="btn" disabled={busy} onClick={run}>{busy ? 'Prüfe…' : '↻ Neu prüfen'}</button>
      </div>

      {err && <div className="banner">{err}</div>}
      {!data && !err && <div className="spinner">Prüfe…</div>}

      {s && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 14, flexWrap: 'wrap' }}>
          <GradeBadge grade={s.grade} size={56} />
          <div>
            <div style={{ fontSize: 26, fontWeight: 800 }}>{s.score}%</div>
            <div className="help">{s.pass} OK · {s.warn} Warnungen · {s.fail} Fehler · {s.na} n/a</div>
          </div>
          {s.critical > 0 && <Badge kind="err">{s.critical} kritisch</Badge>}
          <div style={{ flex: 1 }} />
          <div className="pill-group">
            {['all', 'infra', 'security', 'host', 'issues'].map((f) => (
              <button key={f} className={`btn sm ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>
                {{ all: 'Alle', infra: 'Infrastruktur', security: 'Security', host: 'Host/Daemon', issues: 'Nur Findings' }[f]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>Score-Verlauf (30 Tage)</div>
            <Sparkline points={hist?.points || []} />
            {hist?.points?.length > 0 && (
              <div className="help" style={{ fontSize: 11 }}>
                {hist.points.length} Läufe · zuletzt {hist.points[hist.points.length - 1].score}% ({hist.points[hist.points.length - 1].grade})
              </div>
            )}
          </div>
          <div style={{ flex: 1 }} />
          {sched && (
            <div style={{ minWidth: 260 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                Zeitplan {sched.status?.running ? <Badge kind="ok">aktiv</Badge> : <Badge kind="muted">aus</Badge>}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <input type="checkbox" checked={Boolean(sched.config?.enabled)} disabled={savingSched}
                  onChange={(e) => saveSched({ enabled: e.target.checked })} />
                <span>Automatisch prüfen alle</span>
                <input type="number" min="1" max="168" value={sched.config?.intervalHours ?? 24} disabled={savingSched}
                  style={{ width: 64 }}
                  onChange={(e) => setSched({ ...sched, config: { ...sched.config, intervalHours: Number(e.target.value) } })}
                  onBlur={(e) => saveSched({ intervalHours: Number(e.target.value) })} />
                <span>Std.</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <input type="checkbox" checked={sched.config?.alertOnNewCritical !== false} disabled={savingSched}
                  onChange={(e) => saveSched({ alertOnNewCritical: e.target.checked })} />
                <span>Alert bei neuen kritischen Findings</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={Boolean(sched.config?.alertOnGradeDrop)} disabled={savingSched}
                  onChange={(e) => saveSched({ alertOnGradeDrop: e.target.checked })} />
                <span>Alert bei Noten-Verschlechterung</span>
              </label>
              <div className="help" style={{ fontSize: 11, marginTop: 4 }}>Alerts nutzen die Monitoring-Kanäle (Einstellungen → Monitoring).</div>
            </div>
          )}
        </div>
      </div>

      {data && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Status</th><th>Prüfung</th><th>Schwere</th><th>Details</th></tr></thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{statusBadge(c.status)}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{c.title}</div>
                    <div className="help" style={{ fontSize: 11 }}>
                      <span className="mono">{c.id}</span> · {{ infra: 'Infrastruktur', security: 'Security', host: 'Host/Daemon' }[c.category] || c.category}
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{sevBadge(c.severity)}</td>
                  <td style={{ fontSize: 12 }}>
                    <div>{c.detail}</div>
                    {c.objects?.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '4px 0' }}>
                        {c.objects.slice(0, 8).map((o) => <Badge key={o} kind="muted">{o}</Badge>)}
                        {c.objects.length > 8 && <span className="help">+{c.objects.length - 8}</span>}
                      </div>
                    )}
                    {(c.status === 'warn' || c.status === 'fail') && (
                      <div className="help" style={{ marginTop: 2, color: 'var(--text-dim)' }}>💡 {c.remediation}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function Security() {
  const [tab, setTab] = useState('vuln');
  return (
    <>
      <div className="page-head">
        <div><h1>Security</h1><div className="sub">CVE-Scans, Best Practices & interne Zertifikatsverwaltung (PKI)</div></div>
      </div>
      <TabBar
        tabs={[{ k: 'vuln', label: 'Vulnerability' }, { k: 'bestpractices', label: 'Best Practices' }, { k: 'pki', label: 'PKI' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'vuln' && <Vulnerability />}
      {tab === 'bestpractices' && <BestPractices />}
      {tab === 'pki' && <PkiPanel />}
    </>
  );
}
