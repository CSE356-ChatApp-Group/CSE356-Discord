/**
 * POST /messages e2e trace payload: bridge outcome fields.
 */

const { buildPostMessagesE2eTracePayload } = require('../src/messages/lib/postDiagnostics');

function minimalArgs(overrides: Record<string, unknown> = {}) {
  return {
    req: { id: 'req-1' },
    channelId: 'chan-1',
    conversationId: null,
    postWallStart: 1,
    txPhases: { t0: 0, t_access: 0, t_insert: 0, t_later: 0 },
    total_wall_ms: 200,
    idem_redis_ms: 0,
    channel_insert_lock_wait_ms: 0,
    channel_insert_lock_path: null,
    channel_insert_lock_reason_detail: null,
    successLog: { tx_access_check_ms: 1, tx_insert_ms: 1, tx_later_step_ms: 0, tx_commit_ms: 1, tx_total_ms: 10 },
    hydrate_ms: 1,
    fanout_enqueue_wall_ms: 0,
    recent_bridge_wall_ms: 40,
    fanout_wall_ms: 50,
    cache_bust_only_ms: 10,
    post_hydrate_parallel_wall_ms: 55,
    fanout_mode: 'channel:async_enqueue',
    community_enqueue_ms: 0,
    idem_success_redis_ms: 0,
    serialization_ms: 1,
    response_body_bytes: 100,
    recent_bridge_ok: true,
    recent_bridge_timed_out: false,
    recent_bridge_timeout_ms: 500,
    ...overrides,
  };
}

describe('buildPostMessagesE2eTracePayload', () => {
  it('includes recent bridge outcome fields when provided', () => {
    const p = buildPostMessagesE2eTracePayload(minimalArgs());
    expect(p.recent_bridge_ok).toBe(true);
    expect(p.recent_bridge_timed_out).toBe(false);
    expect(p.recent_bridge_timeout_ms).toBe(500);
    expect(p.event).toBe('post_messages_e2e_trace');
  });

  it('passes through null bridge outcomes for conversation-style payloads', () => {
    const p = buildPostMessagesE2eTracePayload(
      minimalArgs({
        channelId: null,
        conversationId: 'conv-1',
        recent_bridge_ok: null,
        recent_bridge_timed_out: null,
        recent_bridge_timeout_ms: null,
      })
    );
    expect(p.recent_bridge_ok).toBeNull();
    expect(p.recent_bridge_timed_out).toBeNull();
    expect(p.recent_bridge_timeout_ms).toBeNull();
    expect(p.target_type).toBe('conversation');
  });
});
