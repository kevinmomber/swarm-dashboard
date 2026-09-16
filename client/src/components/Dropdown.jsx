import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

/**
 * Lightweight actions dropdown. `items` = [{ label, onClick, danger, disabled, hidden }].
 *
 * The menu is rendered through a portal with fixed positioning so it escapes
 * any `overflow: hidden` / stacking context of the surrounding table and never
 * gets clipped behind other rows. It flips above the trigger when there is not
 * enough room below (e.g. rows near the bottom of the viewport).
 */
export default function Dropdown({ label = 'Aktionen', items = [] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // { top, right, maxHeight }
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const rectRef = useRef(null);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    rectRef.current = r;
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right, maxHeight: null });
  }, []);

  const toggle = () => {
    if (!open) place();
    setOpen((v) => !v);
  };

  // Once the menu has a measurable height, flip it above the trigger if opening
  // below would overflow the viewport bottom, and clamp it inside the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const r = rectRef.current;
    const menu = menuRef.current;
    if (!r || !menu) return;
    const margin = 8;
    const h = menu.offsetHeight;
    const spaceBelow = window.innerHeight - margin - (r.bottom + 4);
    const spaceAbove = r.top - 4 - margin;
    let top;
    let maxHeight = null;
    if (h <= spaceBelow || spaceBelow >= spaceAbove) {
      top = r.bottom + 4; // open below
      if (h > spaceBelow) maxHeight = spaceBelow;
    } else {
      maxHeight = Math.min(h, spaceAbove);
      top = r.top - 4 - maxHeight; // open above
    }
    setPos((p) => (p && p.top === top && p.maxHeight === maxHeight ? p : { ...p, top, maxHeight }));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    // Closing on scroll/resize keeps the fixed menu aligned with its trigger
    // inside scroll containers instead of drifting away from the button.
    const onMove = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const visible = items.filter((i) => !i.hidden);

  return (
    <div className="dropdown" ref={btnRef}>
      <button className="btn sm" onClick={toggle}>{label} ▾</button>
      {open && pos && createPortal(
        <div
          className="dropdown-menu"
          ref={menuRef}
          style={{
            position: 'fixed',
            top: pos.top,
            right: pos.right,
            ...(pos.maxHeight ? { maxHeight: pos.maxHeight, overflowY: 'auto' } : {}),
          }}
        >
          {visible.map((it, i) => (
            <button
              key={i}
              className={`dropdown-item ${it.danger ? 'danger' : ''}`}
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick?.(); }}
            >
              {it.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
