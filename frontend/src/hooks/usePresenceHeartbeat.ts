/**
 * usePresenceHeartbeat
 *
 * Sends presence updates over websocket for this browser connection.
 * Reports 'online' every 45 seconds while visible and reports 'away'
 * when hidden for > 2 minutes.
 */

import { useEffect, useRef } from 'react';
import { wsManager } from '../lib/ws';
import { useAuthStore } from '../stores/authStore';

const HEARTBEAT_MS  = 45_000;
const AWAY_DELAY_MS = 2 * 60_000;

export function usePresenceHeartbeat() {
  const user = useAuthStore(s => s.user);
  const awayTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!user) return;

    function setStatus(status: 'online' | 'idle' | 'away') {
      wsManager.send({ type: 'presence', status });
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
        awayTimerRef.current = window.setTimeout(() => setStatus('away'), AWAY_DELAY_MS);
      } else {
        if (awayTimerRef.current) {
          window.clearTimeout(awayTimerRef.current);
          awayTimerRef.current = null;
        }
        setStatus('online');
      }
    }

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(heartbeat);
      if (awayTimerRef.current) {
        window.clearTimeout(awayTimerRef.current);
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [user?.id]);
}
