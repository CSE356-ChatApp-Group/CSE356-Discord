/**
 * Pure helpers for Redis pub/sub → WS delivery (isolates topic normalization regressions).
 */

const {
  normalizeCommunityTopic,
  isDuplicateSuppressionOnly,
} = require("../../src/websocket/redisPubsubTopicUtils");

describe("redisPubsubTopicUtils characterization", () => {
  it("normalizes community topics with or without prefix", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(normalizeCommunityTopic(`community:${id}`)).toBe(id);
    expect(normalizeCommunityTopic(id)).toBe(id);
    expect(normalizeCommunityTopic("channel:x")).toBe(null);
    expect(normalizeCommunityTopic(null)).toBe(null);
  });

  it("detects duplicate-suppression-only reason maps", () => {
    expect(isDuplicateSuppressionOnly({ dedupe_recent_delivery: 1 })).toBe(true);
    expect(isDuplicateSuppressionOnly({ dedupe_recent_delivery: 2, other: 0 })).toBe(true);
    expect(isDuplicateSuppressionOnly({ dedupe_recent_delivery: 1, ws_slow: 1 })).toBe(false);
    expect(isDuplicateSuppressionOnly({})).toBe(false);
    expect(isDuplicateSuppressionOnly(null)).toBe(false);
  });
});
