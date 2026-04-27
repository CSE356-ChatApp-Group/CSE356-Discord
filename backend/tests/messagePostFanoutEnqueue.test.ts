/**
 * POST /messages async fanout: enqueue returns before job body runs (no request-path await on publish).
 */

describe("messagePostFanout enqueue vs worker", () => {
  beforeEach(async () => {
    jest.resetModules();
    const sideEffects = require("../src/messages/sideEffects");
    await sideEffects.drainAllQueuesForTests(5000);
  });

  afterEach(async () => {
    const sideEffects = require("../src/messages/sideEffects");
    await sideEffects.drainAllQueuesForTests(5000);
  });

  it("enqueueFanoutJob returns before the queued fn starts (setImmediate worker)", async () => {
    const sideEffects = require("../src/messages/sideEffects");
    let bodyStarted = false;
    const enqueued = sideEffects.enqueueFanoutJob("fanout.message_post.channel:test-msg", async () => {
      bodyStarted = true;
    });
    expect(enqueued).toBe(true);
    expect(bodyStarted).toBe(false);
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(bodyStarted).toBe(true);
  });

});
