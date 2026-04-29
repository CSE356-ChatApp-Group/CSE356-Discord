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
    if (filterOnFromEnv() && pipelineCallCount === 1) {
      return {
        exists: jest.fn().mockReturnThis(),
        scard: jest.fn().mockReturnThis(),
        exec: classifyExec,
      };
    }
    return {
      set: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      zremrangebyrank: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      exec: enqueueExec,
    };
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
const trimMetric = { inc: jest.fn() };
const zsetSizeMetric = { observe: jest.fn() };
const guardMetric = { inc: jest.fn() };

jest.mock('../src/utils/metrics', () => ({
  wsPendingReplayUserTrimmedTotal: trimMetric,
  wsPendingUserZsetSize: zsetSizeMetric,
  wsPendingReplayGuardTotal: guardMetric,
  pendingReplayRecipientTotal: pendingClassMetric,
  pendingReplayEntriesPerMessage: pendingEntriesHist,
  offlinePendingSkippedTotal: offlineSkipMetric,
}));

jest.mock('../src/websocket/recentConnect', () => ({
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
    trimMetric.inc.mockReset();
    zsetSizeMetric.observe.mockReset();
    process.env.WS_REPLAY_PENDING_MEMORY_GUARD_ENABLED = 'false';
    process.env.WS_REPLAY_PENDING_ONLY_ACTIVE = 'true';
    process.env.WS_REPLAY_PENDING_LEGACY_ALL = 'false';
  });

  it('skips Redis pending writes when no user is connected or recent', async () => {
    classifyExec.mockResolvedValue([[null, 0], [null, 0], [null, 0]]);
    const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending');
    await enqueuePendingMessageForUsers(['user:ghost'], {
      event: 'message:created',
      data: { id: 'm-off', channel_id: 'c1' },
    });
    expect(pendingEntriesHist.observe).toHaveBeenCalledWith(0);
    expect(offlineSkipMetric.inc).toHaveBeenCalledWith(1);
    expect(pendingClassMetric.inc).toHaveBeenCalledWith({ class: 'offline_skipped' }, 1);
    expect(enqueueExec).not.toHaveBeenCalled();
    expect(pipelineCallCount).toBe(1);
  });

  it('enqueues when user has active connections (scard>0)', async () => {
    classifyExec.mockResolvedValue([[null, 0], [null, 0], [null, 1]]);
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
