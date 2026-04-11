/**
 * Shared test helpers.
 *
 * Pure utility functions with no Jest dependencies – safe to import from any
 * test file without pulling in global test lifecycle hooks.
 */

import { WebSocket } from 'ws';
import { request, app } from './runtime';

// ── User helpers ──────────────────────────────────────────────────────────────

export function uniqueSuffix(): string {
  return `${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

export async function registerUser({
  email,
  username,
  password = 'Password1!',
  displayName,
}: {
  email?: string;
  username: string;
  password?: string;
  displayName?: string;
}) {
  return request(app)
    .post('/api/v1/auth/register')
    .send({ ...(email ? { email } : {}), username, password, displayName: displayName || username });
}

export async function createAuthenticatedUser(prefix: string, opts: { withEmail?: boolean } = {}) {
  const suffix = uniqueSuffix();
  const email = opts.withEmail !== false ? `${prefix}-${suffix}@example.com` : undefined;
  const username = `${prefix}${suffix}`.slice(0, 32);
  const res = await registerUser({ email, username });
  if (res.status !== 201) {
    throw new Error(
      [
        `createAuthenticatedUser failed for prefix=${prefix}`,
        `status=${res.status}`,
        `email=${email}`,
        `username=${username}`,
        `body=${JSON.stringify(res.body)}`,
      ].join(' | '),
    );
  }

  const accessToken = res.body?.accessToken as string | undefined;
  const user = res.body?.user as { id: string; email: string; username: string } | undefined;

  if (!accessToken || !user?.id) {
    throw new Error(
      [
        `createAuthenticatedUser returned incomplete auth payload for prefix=${prefix}`,
        `status=${res.status}`,
        `body=${JSON.stringify(res.body)}`,
      ].join(' | '),
    );
  }

  return {
    email,
    username,
    accessToken,
    user,
  };
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

export function connectWebSocket(
  port: number,
  token: string,
  opts?: { readyTimeoutMs?: number },
): Promise<any> {
  const readyTimeoutMs = opts?.readyTimeoutMs ?? 3000;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Timed out connecting websocket'));
    }, readyTimeoutMs);

    ws.once('open', () => {
      // Wait for the server to send { event: "ready" } after bootstrap
      // completes so the test can rely on all channel subscriptions being active.
      const onMessage = (raw: any) => {
        let parsed: any;
        try { parsed = JSON.parse(raw.toString()); } catch { return; }
        if (parsed?.event === 'ready') {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(ws);
        }
      };
      ws.on('message', onMessage);
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Connect a WebSocket and immediately send `frame` in the `open` handler.
 * Used to exercise the subscribe-on-open race condition fix.
 */
export function connectWebSocketWithOpenFrame(
  port: number,
  token: string,
  frame: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Timed out connecting websocket'));
    }, 3000);

    ws.once('open', () => {
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function waitForRejectedWebSocketConnection(
  port: number,
  token: string,
  timeoutMs = 3000,
): Promise<{ closeCode: number; sawError: boolean; errorMessage: string | null }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    let settled = false;
    let sawError = false;
    let errorMessage: string | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate();
      } catch {
        // Ignore cleanup errors from the timeout path.
      }
      reject(new Error('Expected revoked websocket token to be rejected'));
    }, timeoutMs);

    ws.once('open', () => {
      // The server authenticates immediately after upgrade, so a revoked token
      // may briefly reach OPEN before being closed.
    });

    ws.once('error', (err: Error) => {
      sawError = true;
      errorMessage = err?.message || null;
    });

    ws.once('close', (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ closeCode: code, sawError, errorMessage });
    });
  });
}

export function closeWebSocket(ws: any): Promise<void> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', resolve);
    ws.close();
  });
}

/**
 * Resolve with the first WebSocket message that satisfies `predicate`.
 * Rejects if no matching message arrives within `timeoutMs`.
 */
export function waitForWsEvent(
  ws: any,
  predicate: (event: any) => boolean,
  timeoutMs = 4000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for websocket event'));
    }, timeoutMs);

    const onMessage = (raw: any) => {
      let event: any;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(event)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(event);
    };

    ws.on('message', onMessage);
  });
}

/**
 * Resolve after `timeoutMs` if NO message matching `predicate` arrives.
 * Rejects immediately if a matching message is received.
 */
export function waitForNoWsEvent(
  ws: any,
  predicate: (event: any) => boolean,
  timeoutMs = 750,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve();
    }, timeoutMs);

    const onMessage = (raw: any) => {
      let event: any;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(event)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      reject(new Error(`Unexpected websocket event: ${JSON.stringify(event)}`));
    };

    ws.on('message', onMessage);
  });
}
