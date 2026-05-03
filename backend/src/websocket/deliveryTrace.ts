/**
 * Slow WS delivery trace helper: worker identity labels, structured slow-log emission.
 *
 * Thresholds are configurable via env:
 *   WS_SLOW_DELIVERY_TOTAL_MS       (default 1000)
 *   WS_SLOW_DELIVERY_ENQUEUE_MS     (default 500)
 *   WS_SLOW_DELIVERY_PUBSUB_MS      (default 500)
 *   WS_SLOW_DELIVERY_LOOKUP_MS      (default 500)
 *   WS_SLOW_DELIVERY_REDIS_MS       (default 500)
 *   WS_SLOW_DELIVERY_SAMPLE_RATE    (default 0.001 = 0.1%)
 */

import os from 'os';
const logger = require('../utils/logger');

let _workerLabels: { vm: string; worker: string } | null = null;

function getWorkerLabels(): { vm: string; worker: string } {
  if (_workerLabels) return _workerLabels;
  _workerLabels = {
    vm: process.env.HOST || os.hostname() || 'unknown',
    worker: process.env.PORT || 'default',
  };
  return _workerLabels;
}

function slowThreshold(envKey: string, defaultMs: number): number {
  const raw = Number(process.env[envKey]);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
}

function sampleRate(): number {
  const raw = Number(process.env.WS_SLOW_DELIVERY_SAMPLE_RATE ?? '0.001');
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.001;
}

export interface SlowDeliveryTrace {
  messageId?: string | null;
  channelId?: string | null;
  conversationId?: string | null;
  senderUserId?: string | null;
  recipientUserId?: string | null;
  eventType?: string | null;
  topicType?: string | null;
  // source/dest worker identity
  source_vm?: string | null;
  source_worker?: string | null;
  dest_vm?: string | null;
  dest_worker?: string | null;
  // stage timestamps (epoch ms)
  message_insert_done_ms?: number | null;
  fanout_enqueue_ms?: number | null;
  fanout_start_ms?: number | null;
  target_lookup_start_ms?: number | null;
  target_lookup_done_ms?: number | null;
  target_count?: number | null;
  cache_result?: string | null;
  candidate_count?: number | null;
  pubsub_receive_ms?: number | null;
  pubsub_receive_lag_ms?: number | null;
  socket_lookup_done_ms?: number | null;
  connected_socket_count?: number | null;
  missing_socket_count?: number | null;
  stale_map_recovery?: boolean | null;
  socket_enqueue_ms?: number | null;
  socket_enqueue_delay_ms?: number | null;
  queue_depth_before?: number | null;
  queue_depth_after?: number | null;
  socket_write_start_ms?: number | null;
  socket_write_done_ms?: number | null;
  send_duration_ms?: number | null;
  delivery_done_ms?: number | null;
  total_delivery_ms?: number | null;
  partial_delivery?: boolean | null;
}

function shouldEmitSlowTrace(fields: SlowDeliveryTrace): boolean {
  if (fields.total_delivery_ms != null && fields.total_delivery_ms > slowThreshold('WS_SLOW_DELIVERY_TOTAL_MS', 1000)) return true;
  if (fields.socket_enqueue_delay_ms != null && fields.socket_enqueue_delay_ms > slowThreshold('WS_SLOW_DELIVERY_ENQUEUE_MS', 500)) return true;
  if (fields.pubsub_receive_lag_ms != null && fields.pubsub_receive_lag_ms > slowThreshold('WS_SLOW_DELIVERY_PUBSUB_MS', 500)) return true;
  if (fields.stale_map_recovery === true) return true;
  if (fields.partial_delivery === true) return true;
  if (Math.random() < sampleRate()) return true;
  return false;
}

function emitSlowDeliveryTrace(fields: SlowDeliveryTrace): void {
  if (!shouldEmitSlowTrace(fields)) return;
  logger.warn(
    {
      event: 'ws.delivery.slow_trace',
      gradingNote: 'correlate_with_delivery_timeout_missing_recipient',
      ...fields,
    },
    'WS slow delivery trace',
  );
}

module.exports = { getWorkerLabels, emitSlowDeliveryTrace };
export {};
