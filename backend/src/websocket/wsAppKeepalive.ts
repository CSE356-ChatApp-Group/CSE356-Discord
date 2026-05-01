/**
 * Application-level WS keepalive frames (distinct from ws ping/pong heartbeat).
 */

function createAppKeepaliveSender({
  WebSocket,
  logger,
  noteRecentDisconnectForSocket,
  wsAppKeepaliveIntervalMs,
  wsAppKeepaliveFrame,
  wsBackpressureDropBytes,
}: {
  WebSocket: typeof import('ws').WebSocket;
  logger: { warn: (obj: Record<string, unknown>, msg: string) => void };
  noteRecentDisconnectForSocket: (ws: import('ws').WebSocket, code: number, reason: string) => void;
  wsAppKeepaliveIntervalMs: number;
  wsAppKeepaliveFrame: Buffer | string;
  wsBackpressureDropBytes: number;
}) {
  return function maybeSendAppKeepaliveFrame(ws: import('ws').WebSocket): boolean {
    if (wsAppKeepaliveIntervalMs <= 0) return false;
    if (ws.readyState !== WebSocket.OPEN) return false;

    const now = Date.now();
    const lastFrameAt = Number((ws as any)._lastDataFrameAt || (ws as any)._connectedAt || 0);
    if (!Number.isFinite(lastFrameAt) || now - lastFrameAt < wsAppKeepaliveIntervalMs) {
      return false;
    }

    const buffered = (ws as any).bufferedAmount ?? 0;
    if (buffered >= wsBackpressureDropBytes) {
      return false;
    }

    (ws as any)._lastDataFrameAt = now;
    try {
      ws.send(wsAppKeepaliveFrame, (err) => {
        if (!err) return;
        (ws as any)._sawError = true;
        logger.warn(
          {
            err,
            event: 'ws.keepalive_send_failed',
            userId: (ws as any)._userId,
            gradingNote: 'correlate_with_failed_deliveries',
          },
          'WS keepalive send failed; terminating socket',
        );
        try {
          noteRecentDisconnectForSocket(ws, 1006, 'keepalive_send_failed');
          ws.terminate();
        } catch {
          // Ignore termination failures after send errors.
        }
      });
      return true;
    } catch (err) {
      (ws as any)._sawError = true;
      logger.warn(
        {
          err,
          event: 'ws.keepalive_send_failed',
          userId: (ws as any)._userId,
          gradingNote: 'correlate_with_failed_deliveries',
        },
        'WS keepalive send failed; terminating socket',
      );
      try {
        noteRecentDisconnectForSocket(ws, 1006, 'keepalive_send_failed');
        ws.terminate();
      } catch {
        // Ignore termination failures after send errors.
      }
      return false;
    }
  };
}

module.exports = { createAppKeepaliveSender };
