/**
 * @jest-environment node
 */

const {
  prepareSocketPayload,
  socketMessageDedupeKey,
  wsDeliveryTopicPrefixForMetrics,
} = require("../src/websocket/outboundPayload");

describe("websocket/outboundPayload", () => {
  it("prepareSocketPayload adds channel field for message:created", () => {
    const parsed = {
      event: "message:created",
      data: { id: "mid", channel_id: "ch1", author_id: "u1" },
    };
    const { outbound, dedupeKey } = prepareSocketPayload("channel:ch1", parsed, null);
    expect(dedupeKey).toBe("message:created:mid");
    const o = JSON.parse(String(outbound));
    expect(o.channel).toBe("channel:ch1");
    expect(o.event).toBe("message:created");
  });

  it("wsDeliveryTopicPrefixForMetrics buckets topic prefixes", () => {
    expect(wsDeliveryTopicPrefixForMetrics("channel:x")).toBe("channel");
    expect(wsDeliveryTopicPrefixForMetrics("userfeed:3")).toBe("userfeed");
    expect(socketMessageDedupeKey({ event: "presence:updated" })).toBeNull();
  });

  it("socketMessageDedupeKey maps alias message events to canonical message families", () => {
    expect(
      socketMessageDedupeKey({
        event: "new_message",
        data: { id: "mid", channel_id: "c1" },
      }),
    ).toBe("message:created:mid");
    expect(
      socketMessageDedupeKey({
        event: "message_deleted",
        data: { id: "mid2" },
      }),
    ).toBe("message:deleted:mid2");
  });
});
