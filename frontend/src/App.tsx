import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { api, setToken } from './lib/api';
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
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
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
  const [mode, setMode] = useState<'create' | 'connect'>('create');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createForm, setCreateForm] = useState({ username: '', displayName: '', password: '' });
  const [connectForm, setConnectForm] = useState({ email: '', password: '' });

  const { token, pending } = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      token: params.get('token'),
      pending: params.get('pending'),
    };
  }, []);

  useEffect(() => {
    if (token) {
      setToken(token);
      init().then(() => { window.location.href = '/'; });
    }
  }, [token, init]);

  async function completeOAuthChoice(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setBusy(true);
    setError('');
    try {
      const payload = mode === 'create'
        ? {
            pendingToken: pending,
            username: createForm.username || undefined,
            displayName: createForm.displayName || undefined,
            password: createForm.password || undefined,
          }
        : {
            pendingToken: pending,
            email: connectForm.email,
            password: connectForm.password,
          };

      const endpoint = mode === 'create' ? '/auth/oauth/complete-create' : '/auth/oauth/complete-connect';
      const result = await api.post(endpoint, payload);
      setToken(result.accessToken);
      await init();
      window.location.href = '/';
    } catch (err: any) {
      setError(err?.message || 'Could not complete OAuth sign in');
    } finally {
      setBusy(false);
    }
  }

  if (token) return <AppLoader />;
  if (!pending) return <Navigate to="/login" replace />;

  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', background: 'var(--bg-0)', padding: 24 }}>
      <div style={{ width: 'min(540px, 96vw)', background: 'var(--bg-1)', border: '1px solid var(--border-light)', borderRadius: 12, padding: 20 }}>
        <h2 style={{ marginTop: 0 }}>Complete OAuth sign in</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>Choose whether to create a new account or connect this OAuth login to an existing account.</p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => setMode('create')}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--border-light)',
              background: mode === 'create' ? 'var(--accent)' : 'var(--bg-2)',
              color: mode === 'create' ? 'var(--bg-0)' : 'var(--text)',
              cursor: 'pointer'
            }}
          >
            Create new account
          </button>
          <button
            type="button"
            onClick={() => setMode('connect')}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--border-light)',
              background: mode === 'connect' ? 'var(--accent)' : 'var(--bg-2)',
              color: mode === 'connect' ? 'var(--bg-0)' : 'var(--text)',
              cursor: 'pointer'
            }}
          >
            Connect existing account
          </button>
        </div>

        {error && <div style={{ color: '#ff8c8c', marginBottom: 12 }}>{error}</div>}

        <form onSubmit={completeOAuthChoice} style={{ display: 'grid', gap: 10 }}>
          {mode === 'create' && (
            <>
              <label>
                Username (optional)
                <input
                  value={createForm.username}
                  onChange={e => setCreateForm(f => ({ ...f, username: e.target.value }))}
                  placeholder="devuser"
                  maxLength={32}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </label>
              <label>
                Display name (optional)
                <input
                  value={createForm.displayName}
                  onChange={e => setCreateForm(f => ({ ...f, displayName: e.target.value }))}
                  placeholder="Dev User"
                  maxLength={64}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </label>
              <label>
                Password (optional, for direct login later)
                <input
                  type="password"
                  value={createForm.password}
                  onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="At least 8 characters"
                  minLength={8}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </label>
            </>
          )}

          {mode === 'connect' && (
            <>
              <label>
                Existing account email
                <input
                  type="email"
                  required
                  value={connectForm.email}
                  onChange={e => setConnectForm(f => ({ ...f, email: e.target.value }))}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </label>
              <label>
                Existing account password
                <input
                  type="password"
                  required
                  minLength={8}
                  value={connectForm.password}
                  onChange={e => setConnectForm(f => ({ ...f, password: e.target.value }))}
                  style={{ width: '100%', marginTop: 4 }}
                />
              </label>
            </>
          )}

          <button type="submit" disabled={busy} style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer' }}>
            {busy ? 'Finishing…' : mode === 'create' ? 'Create & continue' : 'Connect & continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
