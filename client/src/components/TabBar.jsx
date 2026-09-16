/** Simple tab bar. tabs = [{ k, label, disabled }]. */
export default function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
      {tabs.map((t) => (
        <button
          key={t.k}
          className="btn sm"
          disabled={t.disabled}
          onClick={() => onChange(t.k)}
          style={{
            border: 'none', borderRadius: 0, background: 'transparent',
            borderBottom: active === t.k ? '2px solid var(--accent, #58a6ff)' : '2px solid transparent',
            color: active === t.k ? 'var(--text)' : 'var(--text-dim)',
            fontWeight: active === t.k ? 700 : 400,
            opacity: t.disabled ? 0.4 : 1,
          }}
          title={t.disabled ? 'Nur bei laufendem Container/Service verfügbar' : undefined}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
