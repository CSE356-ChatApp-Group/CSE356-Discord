import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import styles from './Auth.module.css';

export default function RegisterPage() {
  const [form, setForm] = useState({ email: '', username: '', password: '', displayName: '' });
  // email is optional – the backend accepts null
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const register = useAuthStore(s => s.register);
  const navigate = useNavigate();

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await register(form.email, form.username, form.password, form.displayName);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.bg} data-testid="page-register">
      <main className={styles.card} role="main" aria-label="Register" data-testid="register-card">
        <div className={styles.logo}>
          <span className={styles.logoMark}>▸</span>
          <span className={styles.logoText}>ChatApp</span>
        </div>

        <h1 className={styles.title}>Create account</h1>

        {error && <div className={styles.error} role="alert" data-testid="register-error">{error}</div>}

        <form onSubmit={handleSubmit} className={styles.form} data-testid="register-form">
          <label className={styles.label}>
            Email <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
            <input id="register-email" name="email" type="text" value={form.email} onChange={set('email')}
              className={styles.input} placeholder="you@example.com" autoFocus />
          </label>

          <label className={styles.label}>
            Username
            <input id="register-username" name="username" type="text" value={form.username} onChange={set('username')}
              className={styles.input} placeholder="devuser" required />
          </label>

          <label className={styles.label}>
            Display name <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
            <input id="register-display-name" name="displayName" type="text" value={form.displayName} onChange={set('displayName')}
              className={styles.input} placeholder="Dev User" />
          </label>

          <label className={styles.label}>
            Password
            <input id="register-password" name="password" type="password" value={form.password} onChange={set('password')}
              className={styles.input} placeholder="Password" required />
          </label>

          <button type="submit" className={styles.btn} disabled={loading} data-testid="register-submit">
            {loading ? 'Creating account…' : 'Create account →'}
          </button>
        </form>

        <p className={styles.footer}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </main>
    </div>
  );
}
