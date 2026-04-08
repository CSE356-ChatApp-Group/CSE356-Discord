export type PresenceIntentStatus = 'online' | 'away';

const PRESENCE_INTENT_KEY = 'chatapp:presence-intent';

type PresenceIntentPayload = {
  status: PresenceIntentStatus;
  awayMessage: string;
};

const DEFAULT_INTENT: PresenceIntentPayload = {
  status: 'online',
  awayMessage: '',
};

export function readPresenceIntent(): PresenceIntentPayload {
  if (typeof window === 'undefined') return DEFAULT_INTENT;

  try {
    const raw = window.localStorage.getItem(PRESENCE_INTENT_KEY);
    if (!raw) return DEFAULT_INTENT;

    const parsed = JSON.parse(raw);
    const status: PresenceIntentStatus = parsed?.status === 'away' ? 'away' : 'online';
    const awayMessage = typeof parsed?.awayMessage === 'string' ? parsed.awayMessage : '';
    return { status, awayMessage };
  } catch {
    return DEFAULT_INTENT;
  }
}

export function writePresenceIntent(status: PresenceIntentStatus, awayMessage: string = '') {
  if (typeof window === 'undefined') return;

  const payload: PresenceIntentPayload = {
    status,
    awayMessage: status === 'away' ? awayMessage.trim() : '',
  };

  window.localStorage.setItem(PRESENCE_INTENT_KEY, JSON.stringify(payload));
}
