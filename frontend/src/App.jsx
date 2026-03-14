import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import LoginPage    from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ChatPage     from './pages/ChatPage';

function RequireAuth({ children }) {
  const { user, loading } = useAuthStore();
  if (loading) return <AppLoader />;
  if (!user)   return <Navigate to="/login" replace />;
  return children;
}

function RedirectIfAuthenticated({ children }) {
  const { user, loading } = useAuthStore();
  if (loading) return <AppLoader />;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function AppLoader() {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-0)' }}>
      <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
        <Spinner size={24} />
        <div style={{ marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 12 }}>connecting…</div>
      </div>
    </div>
  );
}

function Spinner({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 0.8s linear infinite' }}>
      <circle cx="12" cy="12" r="10" stroke="var(--border-light)" strokeWidth="3" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function App() {
  const init = useAuthStore(s => s.init);
  useEffect(() => { init(); }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={
          <RedirectIfAuthenticated><LoginPage /></RedirectIfAuthenticated>
        } />
        <Route path="/register" element={
          <RedirectIfAuthenticated><RegisterPage /></RedirectIfAuthenticated>
        } />
        <Route path="/oauth-callback" element={<OAuthCallback />} />
        <Route path="/*" element={
          <RequireAuth><ChatPage /></RequireAuth>
        } />
      </Routes>
    </BrowserRouter>
  );
}

function OAuthCallback() {
  const init = useAuthStore(s => s.init);
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (token) {
      import('./lib/api').then(({ setToken }) => {
        setToken(token);
        init().then(() => { window.location.href = '/'; });
      });
    }
  }, []);
  return <AppLoader />;
}
