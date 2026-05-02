/**
 * In-process fanout side-effect queues: read receipt must not share fanout:critical with POST /messages fanout.
 */

describe("sideEffects fanout queue routing", () => {
  beforeEach(async () => {
    jest.resetModules();
    const sideEffects = require("../src/messages/sideEffects");
    await sideEffects.drainAllQueuesForTests(5000);
  });

  afterEach(async () => {
    const sideEffects = require("../src/messages/sideEffects");
    await sideEffects.drainAllQueuesForTests(5000);
  });

  it("routes fanout.read_receipt to fanout:read_receipt", () => {
    const { routeFanoutQueueForJobName } = require("../src/messages/sideEffects");
    expect(routeFanoutQueueForJobName("fanout.read_receipt")).toBe("fanout:read_receipt");
  });

  it("routes message POST fanout jobs to fanout:critical", () => {
    const { routeFanoutQueueForJobName } = require("../src/messages/sideEffects");
    expect(routeFanoutQueueForJobName("fanout.message_post.channel")).toBe("fanout:critical");
    expect(routeFanoutQueueForJobName("fanout.message_post.conversation")).toBe("fanout:critical");
    expect(routeFanoutQueueForJobName("fanout.channel_message.user_topics")).toBe("fanout:critical");
    expect(routeFanoutQueueForJobName("fanout.publish")).toBe("fanout:critical");
    expect(routeFanoutQueueForJobName("last_message.channel_pointer")).toBe("fanout:critical");
    expect(routeFanoutQueueForJobName("last_message.conversation_pointer")).toBe("fanout:critical");
  });

  it("routes fanout:background.* to fanout:background", () => {
    const { routeFanoutQueueForJobName } = require("../src/messages/sideEffects");
    expect(routeFanoutQueueForJobName("fanout:background.publish")).toBe("fanout:background");
    expect(routeFanoutQueueForJobName("fanout:background.msg_count_reconcile")).toBe(
      "fanout:background",
    );
  });

  it("runs fanout.read_receipt jobs via drainAllQueuesForTests", async () => {
    const sideEffects = require("../src/messages/sideEffects");
    let ran = false;
    const ok = sideEffects.enqueueFanoutJob("fanout.read_receipt", async () => {
      ran = true;
    });
    expect(ok).toBe(true);
    expect(ran).toBe(false);
    await sideEffects.drainAllQueuesForTests(5000);
    expect(ran).toBe(true);
  });

  it("exposes read_receipt queue stats with same shape as background", () => {
    const { getQueueStats } = require("../src/messages/sideEffects");
    const s = getQueueStats();
    expect(s.read_receipt).toEqual(
      expect.objectContaining({
        depth: expect.any(Number),
        active_workers: expect.any(Number),
        concurrency: expect.any(Number),
        max_depth: expect.any(Number),
      }),
    );
    expect(s.read_receipt.concurrency).toBe(2);
    expect(s.read_receipt.max_depth).toBe(10_000);
  });
});
