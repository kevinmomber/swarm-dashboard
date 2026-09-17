import { useState, useCallback, useRef, useEffect, createContext, useContext } from 'react';

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
  // Nur schließen, wenn Maus-Druck UND Loslassen direkt auf dem Overlay
  // passieren. Verhindert, dass eine Textmarkierung, die im Fenster beginnt
  // und außerhalb endet (oder umgekehrt), den Dialog schließt.
  const downOnOverlay = useRef(false);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleDown = (e) => { downOnOverlay.current = e.target === e.currentTarget; };
  const handleUp = (e) => {
    const started = downOnOverlay.current;
    downOnOverlay.current = false;
    if (started && e.target === e.currentTarget && onClose) onClose();
  };

  return (
    <div className="modal-overlay" onMouseDown={handleDown} onMouseUp={handleUp}>
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
