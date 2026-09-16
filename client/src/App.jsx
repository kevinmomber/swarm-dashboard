import { NavLink, Routes, Route } from 'react-router-dom';
import { ToastProvider } from './components/ui.jsx';
import { ThemeProvider, useTheme } from './components/theme.jsx';
import { AuthProvider, useAuth } from './components/auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Nodes from './pages/Nodes.jsx';
import Services from './pages/Services.jsx';
import Stacks from './pages/Stacks.jsx';
import Tasks from './pages/Tasks.jsx';
import Resources from './pages/Resources.jsx';
import Containers from './pages/Containers.jsx';
import Images from './pages/Images.jsx';
import Security from './pages/Security.jsx';
import Settings from './pages/Settings.jsx';

const NAV = [
  { to: '/', label: 'Übersicht', ico: '▚', end: true },
  { to: '/nodes', label: 'Nodes', ico: '◈' },
  { to: '/services', label: 'Services', ico: '⧉' },
  { to: '/stacks', label: 'Stacks', ico: '▤' },
  { to: '/tasks', label: 'Tasks', ico: '☰' },
  { to: '/containers', label: 'Container', ico: '▣' },
  { to: '/images', label: 'Images', ico: '❒' },
  { to: '/resources', label: 'Ressourcen', ico: '⬡' },
  { to: '/security', label: 'Security', ico: '🛡' },
  { to: '/settings', label: 'Einstellungen', ico: '⚙' },
];

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button className="theme-toggle" onClick={toggle}>
      <span className="ico">{theme === 'dark' ? '☾' : '☀'}</span>
      {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
    </button>
  );
}

function UserBox() {
  const { enabled, user, logout } = useAuth();
  if (!enabled || !user) return null;
  return (
    <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', marginTop: 6 }}>
      <div className="help">Angemeldet als</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{user.username}</span>
        <button className="btn sm" onClick={logout}>Abmelden</button>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          <div className="layout">
            <aside className="sidebar">
              <div className="brand">
                <span className="logo">⬡</span>
                <span>Swarm Dashboard</span>
              </div>
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} className="nav-link">
                  <span className="ico">{n.ico}</span>
                  {n.label}
                </NavLink>
              ))}
              <div className="sidebar-footer">
                <ThemeToggle />
                <UserBox />
              </div>
            </aside>
            <main className="main">
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/nodes" element={<Nodes />} />
                <Route path="/services" element={<Services />} />
                <Route path="/stacks" element={<Stacks />} />
                <Route path="/tasks" element={<Tasks />} />
                <Route path="/containers" element={<Containers />} />
                <Route path="/images" element={<Images />} />
                <Route path="/resources" element={<Resources />} />
                <Route path="/security" element={<Security />} />
                <Route path="/settings" element={<Settings />} />
              </Routes>
            </main>
          </div>
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
