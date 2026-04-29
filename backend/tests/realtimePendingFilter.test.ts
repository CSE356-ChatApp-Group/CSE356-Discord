/**
 * WS pending replay: active/recent-only enqueue (WS_REPLAY_PENDING_ONLY_ACTIVE).
 */

const classifyExec = jest.fn();
const enqueueExec = jest.fn();
let pipelineCallCount = 0;

function filterOnFromEnv() {
  const only = String(process.env.WS_REPLAY_PENDING_ONLY_ACTIVE ?? 'true').toLowerCase() !== 'false';
  const legacy = String(process.env.WS_REPLAY_PENDING_LEGACY_ALL || 'false').toLowerCase() === 'true';
  return only && !legacy;
}

const redisMock = {
  status: 'ready',
  info: jest.fn().mockResolvedValue('used_memory:100\nmaxmemory:1000\n'),
  pipeline: jest.fn(() => {
    pipelineCallCount += 1;
    const p = {
      exists: jest.fn().mockReturnThis(),
      scard: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      zremrangebyrank: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      exec: jest.fn(() => {
        if (!filterOnFromEnv()) {
          return enqueueExec();
        }
        if (p.set.mock.calls.length > 0) {
          return enqueueExec();
        }
        return classifyExec();
      }),
    };
    return p;
  }),
};

jest.mock('../src/db/redis', () => redisMock);
jest.mock('../src/messages/messageHydrate', () => ({
  loadHydratedMessageById: jest.fn(async () => null),
  loadHydratedMessagesByIds: jest.fn(async () => new Map()),
}));
jest.mock('../src/messages/realtimePayload', () => ({
  wrapFanoutPayload: jest.fn((event: string, row: unknown) => ({ event, data: row })),
}));

const pendingClassMetric = { inc: jest.fn() };
const pendingEntriesHist = { observe: jest.fn() };
const offlineSkipMetric = { inc: jest.fn() };
const secondProbeRecentMetric = { inc: jest.fn() };
const trimMetric = { inc: jest.fn() };
const zsetSizeMetric = { observe: jest.fn() };
const guardMetric = { inc: jest.fn() };

jest.mock('../src/utils/metrics', () => ({
  wsPendingReplayUserTrimmedTotal: trimMetric,
  wsPendingUserZsetSize: zsetSizeMetric,
  wsPendingReplayGuardTotal: guardMetric,
  pendingReplayRecipientTotal: pendingClassMetric,
  pendingReplayEntriesPerMessage: pendingEntriesHist,
  pendingReplaySecondProbeRecentUserTotal: secondProbeRecentMetric,
  offlinePendingSkippedTotal: offlineSkipMetric,
}));

jest.mock('../src/websocket/recentConnect', () => ({
  wsPendingEligibleKey: (id: string) => `ws:pending_eligible:${id}`,
  wsRecentConnectKey: (id: string) => `ws:recent_connect:${id}`,
  wsReplayPendingEligibilityKey: (id: string) => `ws:replay_pending_eligible:${id}`,
  WS_REPLAY_RECENT_USER_WINDOW_SECONDS: 30,
}));

describe('realtimePending recipient filter', () => {
  beforeEach(() => {
    jest.resetModules();
    pipelineCallCount = 0;
    redisMock.pipeline.mockClear();
    classifyExec.mockReset();
    enqueueExec.mockReset();
    pendingClassMetric.inc.mockReset();
    pendingEntriesHist.observe.mockReset();
    offlineSkipMetric.inc.mockReset();
    secondProbeRecentMetric.inc.mockReset();
    trimMetric.inc.mockReset();
    zsetSizeMetric.observe.mockReset();
    process.env.WS_REPLAY_PENDING_MEMORY_GUARD_ENABLED = 'false';
    process.env.WS_REPLAY_PENDING_ONLY_ACTIVE = 'true';
    process.env.WS_REPLAY_PENDING_LEGACY_ALL = 'false';
    process.env.WS_PENDING_ELIGIBLE_LEGACY_FALLBACK = 'false';
    delete process.env.WS_PENDING_ELIGIBLE_CONVERSATION_MARKER_FALLBACK;
  });

  it('skips Redis pending writes when no user is connected or recent', async () => {
    classifyExec
      .mockResolvedValueOnce([[null, 0], [null, 0]])
      .mockResolvedValueOnce([[null, 0], [null, 0]]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(['user:ghost'], {
      event: 'message:created',
      data: { id: 'm-off', channel_id: 'c1' },
    });
    expect(pendingEntriesHist.observe).toHaveBeenCalledWith(0);
    expect(offlineSkipMetric.inc).toHaveBeenCalledWith(1);
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'offline_skipped' }, 1);
    expect(enqueueExec).not.toHaveBeenCalled();
    expect(pipelineCallCount).toBe(2);
  });

  it('enqueues when user has active connections (scard>0)', async () => {
    classifyExec.mockResolvedValue([[null, 0], [null, 1]]);
    enqueueExec.mockResolvedValue([
      [null, 'OK'],
      [null, 1],
      [null, 1],
      [null, 0],
      [null, 1],
    ]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(['user:live'], {
      event: 'message:created',
      data: { id: 'm-on', channel_id: 'c1' },
    });
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'connected' }, 1);
    expect(pendingEntriesHist.observe).toHaveBeenCalledWith(1);
    expect(enqueueExec).toHaveBeenCalled();
    expect(pipelineCallCount).toBe(2);
  });

  it('skips second EXISTS probe when recentTargets is present but empty (channel-style)', async () => {
    classifyExec.mockResolvedValue([[null, 0], [null, 0]]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(
      ['user:ghost'],
      { event: 'message:created', data: { id: 'm-empty-hint', channel_id: 'c1' } },
      { recentTargets: [] },
    );
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'offline_skipped' }, 1);
    expect(enqueueExec).not.toHaveBeenCalled();
    expect(classifyExec).toHaveBeenCalledTimes(1);
  });

  it('conversation path skips second probe when WS_PENDING_ELIGIBLE_CONVERSATION_MARKER_FALLBACK=false', async () => {
    process.env.WS_PENDING_ELIGIBLE_CONVERSATION_MARKER_FALLBACK = 'false';
    classifyExec.mockResolvedValue([[null, 0], [null, 0]]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(['user:strict'], {
      event: 'message:created',
      data: { id: 'm-strict', channel_id: 'c1' },
    });
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'offline_skipped' }, 1);
    expect(enqueueExec).not.toHaveBeenCalled();
    expect(classifyExec).toHaveBeenCalledTimes(1);
  });

  it('conversation path (no recentTargets opt) second-probes ws:recent_connect when unified misses', async () => {
    classifyExec
      .mockResolvedValueOnce([[null, 0], [null, 0]])
      .mockResolvedValueOnce([[null, 1], [null, 0]]);
    enqueueExec.mockResolvedValue([
      [null, 'OK'],
      [null, 1],
      [null, 1],
      [null, 0],
      [null, 1],
    ]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(['user:conv'], {
      event: 'message:created',
      data: { id: 'm-conv-rc', channel_id: 'c1' },
    });
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'recent' }, 1);
    expect(secondProbeRecentMetric.inc).toHaveBeenCalledWith({ mode: 'conversation_marker' }, 1);
    expect(enqueueExec).toHaveBeenCalled();
    expect(classifyExec).toHaveBeenCalledTimes(2);
  });

  it('enqueues recent class when recentTargets hints user and scard=0 (no EXISTS)', async () => {
    classifyExec.mockResolvedValue([[null, 0]]);
    enqueueExec.mockResolvedValue([
      [null, 'OK'],
      [null, 1],
      [null, 1],
      [null, 0],
      [null, 1],
    ]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(
      ['user:hinted'],
      { event: 'message:created', data: { id: 'm-hint', channel_id: 'c1' } },
      { recentTargets: ['user:hinted'] },
    );
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'recent' }, 1);
    expect(pendingEntriesHist.observe).toHaveBeenCalledWith(1);
    expect(enqueueExec).toHaveBeenCalled();
    expect(pipelineCallCount).toBe(2);
  });

  it('legacy fallback enqueues recent when unified key miss but ws:recent_connect set', async () => {
    process.env.WS_PENDING_ELIGIBLE_LEGACY_FALLBACK = 'true';
    classifyExec
      .mockResolvedValueOnce([[null, 0], [null, 0]])
      .mockResolvedValueOnce([[null, 1], [null, 0]]);
    enqueueExec.mockResolvedValue([
      [null, 'OK'],
      [null, 1],
      [null, 1],
      [null, 0],
      [null, 1],
    ]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(['user:legacy'], {
      event: 'message:created',
      data: { id: 'm-leg-rc', channel_id: 'c1' },
    });
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'recent' }, 1);
    expect(secondProbeRecentMetric.inc).toHaveBeenCalledWith({ mode: 'legacy_global' }, 1);
    expect(enqueueExec).toHaveBeenCalled();
    expect(classifyExec).toHaveBeenCalledTimes(2);
  });

  it('legacy fallback still skips when unified and legacy markers all absent', async () => {
    process.env.WS_PENDING_ELIGIBLE_LEGACY_FALLBACK = 'true';
    classifyExec
      .mockResolvedValueOnce([[null, 0], [null, 0]])
      .mockResolvedValueOnce([[null, 0], [null, 0]]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(['user:gone'], {
      event: 'message:created',
      data: { id: 'm-leg-off', channel_id: 'c1' },
    });
    expect(offlineSkipMetric.inc).toHaveBeenCalledWith(1);
    expect(enqueueExec).not.toHaveBeenCalled();
    expect(classifyExec).toHaveBeenCalledTimes(2);
  });

  it('enqueues when pending eligible marker exists (single EXISTS + scard)', async () => {
    classifyExec.mockResolvedValue([[null, 1], [null, 0]]);
    enqueueExec.mockResolvedValue([
      [null, 'OK'],
      [null, 1],
      [null, 1],
      [null, 0],
      [null, 1],
    ]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(['user:marked'], {
      event: 'message:created',
      data: { id: 'm-mark', channel_id: 'c1' },
    });
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'recent' }, 1);
    expect(enqueueExec).toHaveBeenCalled();
  });

  it('legacy mode enqueues all targets without classify pipeline', async () => {
    process.env.WS_REPLAY_PENDING_ONLY_ACTIVE = 'false';
    pipelineCallCount = 0;
    enqueueExec.mockResolvedValue([
      [null, 'OK'],
      [null, 1],
      [null, 1],
      [null, 0],
      [null, 1],
    ]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(['user:a', 'user:b'], {
      event: 'message:created',
      data: { id: 'm-leg', channel_id: 'c1' },
    });
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'legacy_enqueue' }, 2);
    expect(classifyExec).not.toHaveBeenCalled();
    expect(enqueueExec).toHaveBeenCalled();
    expect(pipelineCallCount).toBe(1);
  });

  it('WS_REPLAY_PENDING_LEGACY_ALL bypasses filter', async () => {
    process.env.WS_REPLAY_PENDING_LEGACY_ALL = 'true';
    process.env.WS_REPLAY_PENDING_ONLY_ACTIVE = 'true';
    pipelineCallCount = 0;
    enqueueExec.mockResolvedValue([
      [null, 'OK'],
      [null, 1],
      [null, 1],
      [null, 0],
      [null, 1],
    ]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(['user:x'], {
      event: 'message:created',
      data: { id: 'm-old', channel_id: 'c1' },
    });
    expect(classifyExec).not.toHaveBeenCalled();
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'legacy_enqueue' }, 1);
    expect(pipelineCallCount).toBe(1);
  });
});
