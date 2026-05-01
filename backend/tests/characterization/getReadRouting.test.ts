/**
 * GET /messages primary vs replica routing (guards read-your-writes / replica lag retry).
 */

jest.mock("../../src/db/pool", () => ({
  query: jest.fn(),
  queryRead: jest.fn(),
  readPool: {},
}));

const pool = require("../../src/db/pool");
const {
  wantsMessagesListPrimary,
  messagesListQuery,
  channelMessagesListQueryWithPrimaryRetry,
} = require("../../src/messages/routes/getReadRouting");

describe("getReadRouting characterization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.readPool = {};
  });

  function mockReq(overrides: Record<string, unknown> = {}) {
    const headers: Record<string, string> =
      (overrides.headers as Record<string, string>) || {};
    return {
      get(name: string) {
        const key = name.toLowerCase();
        return headers[key] ?? "";
      },
      query: (overrides.query as Record<string, unknown>) || {},
    };
  }

  it("wantsMessagesListPrimary follows header, conversation, and replica availability", () => {
    expect(wantsMessagesListPrimary(mockReq())).toBe(false);

    expect(
      wantsMessagesListPrimary(
        mockReq({
          headers: { "x-chatapp-read-consistency": "primary" },
        }),
      ),
    ).toBe(true);

    expect(
      wantsMessagesListPrimary(
        mockReq({
          query: {
            conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          },
        }),
      ),
    ).toBe(true);
  });

  it("messagesListQuery uses primary when forced", async () => {
    pool.query.mockResolvedValueOnce({ rows: [1] });
    const req = mockReq({
      headers: { "x-chatapp-read-consistency": "strong" },
    });
    await messagesListQuery(req, "SELECT 1", []);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.queryRead).not.toHaveBeenCalled();
  });

  it("messagesListQuery uses replica when not forced", async () => {
    pool.queryRead.mockResolvedValueOnce({ rows: [2] });
    await messagesListQuery(mockReq(), "SELECT 2", []);
    expect(pool.queryRead).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("channelMessagesListQueryWithPrimaryRetry falls back to primary when replica denies access", async () => {
    pool.queryRead.mockResolvedValueOnce({ rows: [{ has_access: false }] });
    pool.query.mockResolvedValueOnce({ rows: [{ has_access: true }] });
    const req = mockReq();
    const out = await channelMessagesListQueryWithPrimaryRetry(
      req,
      "SELECT access",
      [],
    );
    expect(pool.queryRead).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(out.rows[0].has_access).toBe(true);
  });

  it("channelMessagesListQueryWithPrimaryRetry stops at replica when access granted", async () => {
    pool.queryRead.mockResolvedValueOnce({ rows: [{ has_access: true }] });
    const out = await channelMessagesListQueryWithPrimaryRetry(
      mockReq(),
      "SELECT access",
      [],
    );
    expect(pool.queryRead).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(out.rows[0].has_access).toBe(true);
  });
});
