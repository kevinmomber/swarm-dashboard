import { useState, useCallback, useEffect, createContext, useContext } from 'react';

/* ---------- Toast ---------- */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const show = useCallback((message, kind = 'ok') => {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </ToastCtx.Provider>
  );
}

/* ---------- Modal ---------- */
export function Modal({ title, onClose, children, footer, wide }) {
  // Dialoge schließen NICHT mehr durch Klick/Markierung neben dem Fenster
  // (verhindert versehentliches Schließen samt Datenverlust, z.B. beim
  // Bearbeiten langer Compose-Dateien). Schließen nur über ×, Footer-Buttons
  // oder die Escape-Taste.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay">
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="x-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- Badge ---------- */
export function Badge({ kind = 'muted', children }) {
  return (
    <span className={`badge ${kind}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function stateKind(state) {
  const s = (state || '').toLowerCase();
  if (['running', 'ready', 'active', 'complete'].includes(s)) return 'ok';
  if (['preparing', 'starting', 'pending', 'new', 'assigned', 'accepted', 'pause', 'updating'].includes(s))
    return 'warn';
  if (['failed', 'rejected', 'shutdown', 'orphaned', 'down', 'drain'].includes(s)) return 'err';
  return 'muted';
}

/* ---------- helpers ---------- */
export function bytes(n) {
  if (!n && n !== 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function ago(iso) {
  if (!iso) return '–';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std`;
  return `vor ${Math.floor(diff / 86400)} Tg`;
}

export function short(id) {
  return (id || '').replace(/^.*:/, '').slice(0, 12);
}

/* ---------- Copy-to-clipboard button ---------- */
export function Copy({ text, title = 'In Zwischenablage kopieren', label }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const copy = async (e) => {
    e?.stopPropagation?.();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(String(text));
      else {
        const ta = document.createElement('textarea');
        ta.value = String(text); document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      setDone(true); setTimeout(() => setDone(false), 1200);
      toast('Kopiert');
    } catch { toast('Kopieren fehlgeschlagen', 'err'); }
  };
  return (
    <button type="button" className="copy-btn" onClick={copy} title={title}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.7, padding: '0 4px', fontSize: 12 }}>
      {done ? '✓' : '⧉'}{label ? <span style={{ marginLeft: 4 }}>{label}</span> : null}
    </button>
  );
}

/* ---------- localStorage-backed state (filter/column persistence) ---------- */
export function usePersistentState(key, initial) {
  const storageKey = `swarmdash.pref.${key}`;
  const [val, setVal] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw != null ? JSON.parse(raw) : initial;
    } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(val)); } catch { /* ignore */ }
  }, [storageKey, val]);
  return [val, setVal];
}

/** Days until an ISO date (negative = already expired). */
export function daysUntil(iso) {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400000);
}

/** Badge kind + label for a certificate/CA expiry. */
export function expiryInfo(iso) {
  const d = daysUntil(iso);
  if (d === null) return { kind: 'muted', label: '–', days: null };
  if (d < 0) return { kind: 'err', label: `abgelaufen (${-d} Tg)`, days: d };
  if (d <= 14) return { kind: 'err', label: `${d} Tg`, days: d };
  if (d <= 30) return { kind: 'warn', label: `${d} Tg`, days: d };
  return { kind: 'ok', label: `${d} Tg`, days: d };
}
