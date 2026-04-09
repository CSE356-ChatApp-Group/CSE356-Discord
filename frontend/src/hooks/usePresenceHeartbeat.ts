import { useEffect, useRef } from 'react';
import { wsManager } from '../lib/ws';
import { useAuthStore } from '../stores/authStore';
import { readPresenceIntent } from '../lib/presenceIntent';

const ACTIVITY_THROTTLE_MS = 15_000;

export function usePresenceHeartbeat() {
  const user = useAuthStore(s => s.user);
  const lastActivityAtRef = useRef(0);

  useEffect(() => {
    if (!user) return;

    function sendPresenceFromIntent() {
      const intent = readPresenceIntent();
      if (intent.status !== 'away') return;
      wsManager.send({
        type: 'presence',
        status: intent.status,
        awayMessage: intent.status === 'away' ? (intent.awayMessage || null) : null,
      });
    }

    function sendActivity(force = false) {
      if (document.hidden) return;
      if (readPresenceIntent().status === 'away') return;
      const now = Date.now();
      if (!force && now - lastActivityAtRef.current < ACTIVITY_THROTTLE_MS) return;
      lastActivityAtRef.current = now;
      wsManager.send({ type: 'activity' });
    }

    function reportActivity() {
      sendActivity(false);
    }

    function syncPresenceOnConnect() {
      sendPresenceFromIntent();
    }

    syncPresenceOnConnect();
    const unsubscribeOpen = wsManager.onOpen(syncPresenceOnConnect);

    function onVisibility() {
      if (!document.hidden) reportActivity();
    }

    const activityEvents: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, reportActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      unsubscribeOpen();
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, reportActivity);
      });
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [user?.id]);
}
