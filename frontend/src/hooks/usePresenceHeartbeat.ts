/**
 * usePresenceHeartbeat
 *
 * Sends a presence ping every 45 seconds while the tab is visible,
 * and marks the user as 'away' when the tab is hidden for > 2 minutes.
 * The backend Redis TTL is 90s, so a 45s interval ensures the key never expires.
 */

import { useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';

const HEARTBEAT_MS  = 45_000;
const AWAY_DELAY_MS = 2 * 60_000;

export function usePresenceHeartbeat() {
  const user = useAuthStore(s => s.user);
  const awayTimerRef = useRef(null);

  useEffect(() => {
    if (!user) return;

    async function setStatus(status) {
      try { await api.put('/presence', { status }); } catch { /* ignore – non-critical */ }
    }

    // Initial ping
    setStatus('online');

    // Periodic heartbeat
    const heartbeat = setInterval(() => {
      if (!document.hidden) setStatus('online');
    }, HEARTBEAT_MS);

    // Visibility change → away after 2 min hidden
    function onVisibility() {
      if (document.hidden) {
        awayTimerRef.current = setTimeout(() => setStatus('away'), AWAY_DELAY_MS);
      } else {
        clearTimeout(awayTimerRef.current);
        setStatus('online');
      }
    }

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(heartbeat);
      clearTimeout(awayTimerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
      setStatus('offline');
    };
  }, [user?.id]);
}
