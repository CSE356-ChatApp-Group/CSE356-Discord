import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

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

import { usePresenceHeartbeat } from './usePresenceHeartbeat';
import { useAuthStore } from '../stores/authStore';

function Harness() {
  usePresenceHeartbeat();
  return <div data-testid="heartbeat-harness" />;
}

describe('usePresenceHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useAuthStore.setState({ user: { id: 'user-1', username: 'sam', email: 'sam@example.com' } } as any);
  });

  afterEach(() => {
    useAuthStore.setState({ user: null } as any);
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

    invokeOpen();

    const awayPresenceCalls = sendMock.mock.calls.filter(([payload]) => payload?.type === 'presence' && payload?.status === 'away');
    expect(awayPresenceCalls).toHaveLength(2);
  });
});
