/**
 * Async POST fanout: skip duplicate loadHydratedMessageById when safe (see postFanout.ts).
 */

const mockLoadHydrated = jest.fn();

jest.mock("../src/messages/messageHydrate", () => ({
  loadHydratedMessageById: (...args: unknown[]) => mockLoadHydrated(...args),
}));

describe("postFanout async hydrate resolution", () => {
  let resolveChannelMessageForAsyncFanoutJob: (
    opts: Record<string, unknown>,
  ) => Promise<unknown>;
  let resolveConversationMessageForAsyncFanoutJob: (
    opts: Record<string, unknown>,
  ) => unknown;

  beforeEach(() => {
    jest.resetModules();
    mockLoadHydrated.mockReset();
    mockLoadHydrated.mockResolvedValue({
      id: "m1",
      channel_id: "ch1",
      attachments: [],
    });
    ({
      resolveChannelMessageForAsyncFanoutJob,
      resolveConversationMessageForAsyncFanoutJob,
    } = require("../src/messages/routes/postFanout"));
  });

  it("channel: uses in-memory message when postAttachmentCount is 0", async () => {
    const msg = { id: "m1", channel_id: "ch1", attachments: [] };
    const out = await resolveChannelMessageForAsyncFanoutJob({
      postAttachmentCount: 0,
      channelId: "ch1",
      baseMessageId: "m1",
      message: msg,
    });
    expect(out).toBe(msg);
    expect(mockLoadHydrated).not.toHaveBeenCalled();
  });

  it("channel: hydrates when postAttachmentCount > 0", async () => {
    const out = await resolveChannelMessageForAsyncFanoutJob({
      postAttachmentCount: 2,
      channelId: "ch1",
      baseMessageId: "m1",
      message: {},
    });
    expect(mockLoadHydrated).toHaveBeenCalledWith("m1");
    expect(out).toEqual(
      expect.objectContaining({ id: "m1", channel_id: "ch1" }),
    );
  });

  it("channel: returns null when skip-hydrate validation fails", async () => {
    const out = await resolveChannelMessageForAsyncFanoutJob({
      postAttachmentCount: 0,
      channelId: "ch1",
      baseMessageId: "m1",
      message: { id: "m1", channel_id: "other" },
    });
    expect(out).toBe(null);
    expect(mockLoadHydrated).not.toHaveBeenCalled();
  });

  it("conversation: uses in-memory message", () => {
    const msg = { id: "m1", conversation_id: "cv1" };
    const out = resolveConversationMessageForAsyncFanoutJob({
      message: msg,
      conversationId: "cv1",
      baseMessageId: "m1",
    });
    expect(out).toBe(msg);
    expect(mockLoadHydrated).not.toHaveBeenCalled();
  });

  it("conversation: returns null on conversation mismatch", () => {
    const out = resolveConversationMessageForAsyncFanoutJob({
      message: { id: "m1", conversation_id: "other" },
      conversationId: "cv1",
      baseMessageId: "m1",
    });
    expect(out).toBe(null);
  });
});
