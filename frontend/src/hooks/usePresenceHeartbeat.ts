import { useEffect, useRef } from 'react';
import { wsManager } from '../lib/ws';
import { useAuthStore } from '../stores/authStore';

const ACTIVITY_THROTTLE_MS = 15_000;

export function usePresenceHeartbeat() {
  const user = useAuthStore(s => s.user);
  const lastActivityAtRef = useRef(0);

  useEffect(() => {
    if (!user) return;

    // Start as online unless the user explicitly switches to away later.
    wsManager.send({ type: 'presence', status: 'online' });

    function reportActivity() {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastActivityAtRef.current < ACTIVITY_THROTTLE_MS) return;
      lastActivityAtRef.current = now;
      wsManager.send({ type: 'activity' });
    }

    function onVisibility() {
      if (!document.hidden) reportActivity();
    }

    const activityEvents: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, reportActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, reportActivity);
      });
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [user?.id]);
}
