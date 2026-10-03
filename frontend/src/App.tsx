import { useEffect, useState } from 'react';
import { api, hasToken, setToken, setUnauthorizedHandler, type User } from './api';
import { NotificationBell } from './components/NotificationBell';
import { Dashboard } from './pages/Dashboard';
import { Developers } from './pages/Developers';
import { History } from './pages/History';
import { Login } from './pages/Login';
import { Send } from './pages/Send';
import { TransferPage } from './pages/TransferPage';
import { navigate, useRoute } from './router';

const NAV = [
  ['/', 'Overview'],
  ['/send', 'Send money'],
  ['/history', 'History'],
  ['/developers', 'Developers'],
] as const;

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(hasToken());
  const route = useRoute();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
    });
    if (!hasToken()) return;
    api
      .me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <main className="center muted">Loading…</main>;
  if (!user) {
    return (
      <Login
        onSignedIn={(u, token) => {
          setToken(token);
          setUser(u);
          navigate('/');
        }}
      />
    );
  }

  const page = (() => {
    if (route === '/send') return <Send />;
    if (route === '/history' || route.startsWith('/history?')) return <History />;
    if (route.startsWith('/transfers/')) return <TransferPage id={route.slice('/transfers/'.length)} />;
    if (route === '/developers') return <Developers />;
    return <Dashboard />;
  })();

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          Move the Money
        </a>
        <nav aria-label="Main">
          {NAV.map(([path, label]) => (
            <a key={path} href={`#${path}`} aria-current={(path === '/' ? route === '/' : route.startsWith(path)) ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <div className="topbar-end">
          <NotificationBell />
          <span className="muted small" title={user.email}>{user.email}</span>
          <button
            className="ghost"
            onClick={() => {
              setToken(null);
              setUser(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="content">{page}</main>
    </div>
  );
}
