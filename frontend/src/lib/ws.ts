/**
 * ws.js – WebSocket manager
 *
 * Single persistent connection.  Consumers subscribe to channel keys
 * and receive deserialized event objects.
 *
 * Usage:
 *   wsManager.connect(token)
 *   const unsub = wsManager.subscribe('channel:<id>', (event) => { … })
 *   wsManager.send({ type: 'subscribe', channel: 'channel:<id>' })
 *   unsub()         // clean up listener
 *   wsManager.disconnect()
 */

import { getToken } from './api';

function getWebSocketBaseUrl() {
  const configured = import.meta.env.VITE_WS_BASE;
  if (configured) return configured.replace(/\/$/, '');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

const MAX_PENDING_WS_OUTBOUND = 256;

class WsManager {
  private _ws: WebSocket | null;
  private _listeners: Map<string, Set<(event: any) => void>>;
  private _globalListeners: Set<(event: any) => void>;
  private _openListeners: Set<() => void>;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null;
  private _intentionalClose: boolean;
  /** Frames queued while readyState === CONNECTING (subscribe must not be dropped). */
  private _pendingOutbound: string[];

  constructor() {
    this._ws         = null;
    this._listeners  = new Map(); // channel → Set<fn>
    this._globalListeners = new Set();
    this._openListeners = new Set();
    this._reconnectTimer  = null;
    this._intentionalClose = false;
    this._pendingOutbound = [];
  }

  connect(options: { allowAnonymous?: boolean } = {}) {
    const { allowAnonymous = false } = options;
    const token = getToken();
    if (!token && !allowAnonymous) return;

    if (this._ws?.readyState === WebSocket.OPEN || this._ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this._intentionalClose = false;
    const baseUrl = getWebSocketBaseUrl();
    const url = token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
    this._ws = new WebSocket(url);

    this._ws.onopen = () => {
      console.debug('[WS] connected');
      this._flushPendingOutbound();
      this._openListeners.forEach((fn) => fn());
      // Re-subscribe to all watched channels after reconnect
      for (const ch of this._listeners.keys()) {
        if (this._listeners.get(ch).size > 0) {
          this.send({ type: 'subscribe', channel: ch });
        }
      }
    };

    this._ws.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data);
        // Notify global listeners
        this._globalListeners.forEach(fn => fn(event));
        // Notify channel-specific listeners for the event's channel only.
        const eventChannel = event?.channel;
        if (eventChannel && this._listeners.has(eventChannel)) {
          this._listeners.get(eventChannel)?.forEach(fn => fn(event));
        }
      } catch { /* ignore */ }
    };

    this._ws.onclose = (event) => {
      this._pendingOutbound = [];
      if (event.code === 4001) {
        this.disconnect();
        window.dispatchEvent(new CustomEvent('chatapp:session-expired'));
        return;
      }

      if (!this._intentionalClose) {
        console.debug('[WS] disconnected – reconnecting in 3s');
        this._reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    };

    this._ws.onerror = (err) => console.warn('[WS] error', err);
  }

  disconnect() {
    this._intentionalClose = true;
    this._pendingOutbound = [];
    clearTimeout(this._reconnectTimer);
    this._ws?.close();
    this._ws = null;
  }

  private _flushPendingOutbound() {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this._pendingOutbound.length === 0) return;
    for (const payload of this._pendingOutbound) {
      ws.send(payload);
    }
    this._pendingOutbound = [];
  }

  send(msg: Record<string, any>) {
    const payload = JSON.stringify(msg);
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(payload);
      return;
    }
    if (this._ws?.readyState === WebSocket.CONNECTING) {
      if (this._pendingOutbound.length >= MAX_PENDING_WS_OUTBOUND) {
        this._pendingOutbound.splice(0, this._pendingOutbound.length - MAX_PENDING_WS_OUTBOUND + 1);
      }
      this._pendingOutbound.push(payload);
    }
  }

  /** Subscribe to events for a specific Redis channel key */
  subscribe(channel: string, fn: (event: any) => void) {
    if (!this._listeners.has(channel)) this._listeners.set(channel, new Set());
    this._listeners.get(channel).add(fn);
    // Tell server to subscribe this process if not already
    this.send({ type: 'subscribe', channel });
    return () => this._listeners.get(channel)?.delete(fn);
  }

  /** Subscribe to ALL events (useful for global notification handling) */
  onAny(fn: (event: any) => void) {
    this._globalListeners.add(fn);
    return () => this._globalListeners.delete(fn);
  }

  /** Subscribe to WebSocket open events (including reconnect). */
  onOpen(fn: () => void) {
    this._openListeners.add(fn);
    return () => this._openListeners.delete(fn);
  }
}

export const wsManager = new WsManager();
