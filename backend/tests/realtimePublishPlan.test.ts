/**
 * @jest-environment node
 */

describe("realtime/publishPlan", () => {
  it("publishConversationMessageCreatedPlan delegates to publishConversationEventNow", async () => {
    const {
      publishConversationMessageCreatedPlan,
    } = require("../src/realtime/publishPlan");
    const row = { id: "m1", conversation_id: "cv1" };
    const publish = jest.fn(async () => "2026-01-01T00:00:00.000Z");
    const out = await publishConversationMessageCreatedPlan(publish, "cv1", row);
    expect(publish).toHaveBeenCalledWith("cv1", "message:created", row);
    expect(out).toBe("2026-01-01T00:00:00.000Z");
  });
});
