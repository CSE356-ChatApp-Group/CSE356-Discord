import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

const { sendMock, onOpenMock, invokeOpen } = vi.hoisted(() => {
  const sendMock = vi.fn();
  let openHandler: (() => void) | null = null;
  const onOpenMock = vi.fn((handler: () => void) => {
    openHandler = handler;
    return vi.fn();
  });

  return {
    sendMock,
    onOpenMock,
    invokeOpen: () => {
      openHandler?.();
    },
  };
});

vi.mock('../lib/ws', () => ({
  wsManager: {
    send: sendMock,
    onOpen: onOpenMock,
  },
}));

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    postForm: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  setToken: vi.fn(),
  getToken: vi.fn(() => null),
}));

import { usePresenceHeartbeat } from './usePresenceHeartbeat';
import { useAuthStore } from '../stores/authStore';

function Harness() {
  usePresenceHeartbeat();
  return <div data-testid="heartbeat-harness" />;
}

describe('usePresenceHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, String(value)); },
        removeItem: (key: string) => { storage.delete(key); },
        clear: () => { storage.clear(); },
      },
    });
    window.localStorage.clear();
    act(() => {
      useAuthStore.setState({ user: { id: 'user-1', username: 'sam', email: 'sam@example.com' } } as any);
    });
  });

  afterEach(() => {
    act(() => {
      useAuthStore.setState({ user: null } as any);
    });
  });

  it('reapplies persisted away intent on mount and websocket reconnect, and suppresses activity while away', () => {
    window.localStorage.setItem('chatapp:presence-intent', JSON.stringify({ status: 'away', awayMessage: 'brb' }));

    render(<Harness />);

    expect(onOpenMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      type: 'presence',
      status: 'away',
      awayMessage: 'brb',
    });

    fireEvent.pointerDown(window);
    const activityCalls = sendMock.mock.calls.filter(([payload]) => payload?.type === 'activity');
    expect(activityCalls).toHaveLength(0);

    act(() => {
      invokeOpen();
    });

    const awayPresenceCalls = sendMock.mock.calls.filter(([payload]) => payload?.type === 'presence' && payload?.status === 'away');
    expect(awayPresenceCalls).toHaveLength(2);
  });

  it('does not treat websocket connect or reconnect as activity for normal online presence', () => {
    render(<Harness />);

    expect(onOpenMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls.filter(([payload]) => payload?.type === 'presence')).toHaveLength(0);
    expect(sendMock.mock.calls.filter(([payload]) => payload?.type === 'activity')).toHaveLength(0);

    fireEvent.pointerDown(window);
    expect(sendMock).toHaveBeenCalledWith({ type: 'activity' });

    act(() => {
      invokeOpen();
    });
    expect(sendMock.mock.calls.filter(([payload]) => payload?.type === 'activity')).toHaveLength(1);
  });
});
