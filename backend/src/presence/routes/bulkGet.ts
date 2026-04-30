/**
 * GET /presence — bulk status lookup
 */

const presence = require("../service");

const PRESENCE_MAX_IDS = 100;

module.exports = function registerPresenceGetRoute(router: import("express").IRouter) {
  router.get("/", async (req: any, res: any, next: any) => {
    try {
      const ids = (req.query.userIds || "").split(",").filter(Boolean).slice(0, PRESENCE_MAX_IDS);
      if (!ids.length) return res.status(400).json({ error: "userIds query param required" });
      const details = (await presence.getBulkPresenceDetails(ids)) as Record<
        string,
        { status: string; awayMessage: string | null }
      >;
      const map = Object.fromEntries(Object.entries(details).map(([id, d]) => [id, d.status]));
      const awayMessages = Object.fromEntries(
        Object.entries(details)
          .filter(([, d]) => d?.awayMessage)
          .map(([id, d]) => [id, d.awayMessage]),
      );
      res.json({ presence: map, awayMessages });
    } catch (err) {
      next(err);
    }
  });
};
