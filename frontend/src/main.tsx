import React from 'react';
import ReactDOM from 'react-dom/client';
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import App from './App';
import './styles.css';

if (import.meta.env.VITE_ENABLE_RUM === 'true') {
  const apiBase = (import.meta.env.VITE_API_BASE || '/api/v1').replace(/\/$/, '');
  const metrics: { name: string; value: number }[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!metrics.length) return;
      const body = JSON.stringify({ metrics: metrics.splice(0, metrics.length) });
      const url = `${apiBase}/rum`;
      try {
        if (navigator.sendBeacon) {
          const ok = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
          if (ok) return;
        }
      } catch {
        /* fall through */
      }
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        credentials: 'include',
        keepalive: true,
      }).catch(() => {});
    }, 1500);
  }

  function push(m: { name: string; value: number }) {
    metrics.push(m);
    scheduleFlush();
  }

  onLCP((m) => push({ name: 'LCP', value: m.value }));
  onINP((m) => push({ name: 'INP', value: m.value }));
  onCLS((m) => push({ name: 'CLS', value: m.value }));
  onFCP((m) => push({ name: 'FCP', value: m.value }));
  onTTFB((m) => push({ name: 'TTFB', value: m.value }));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && metrics.length) {
      const body = JSON.stringify({ metrics: metrics.splice(0, metrics.length) });
      const url = `${apiBase}/rum`;
      try {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } catch {
        void fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          credentials: 'include',
          keepalive: true,
        }).catch(() => {});
      }
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
