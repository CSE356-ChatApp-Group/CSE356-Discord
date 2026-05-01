/**
 * Characterization tests for POST /messages tunables (guards refactors of postConstants).
 */

const {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS,
} = require("../../src/messages/routes/postConstants");

describe("postConstants characterization", () => {
  it("attachment policy is stable", () => {
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(4);
    expect(ALLOWED_ATTACHMENT_TYPES.has("image/jpeg")).toBe(true);
    expect(ALLOWED_ATTACHMENT_TYPES.has("application/pdf")).toBe(false);
  });

  it("insert statement timeout is bounded", () => {
    expect(MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(60000);
  });
});
