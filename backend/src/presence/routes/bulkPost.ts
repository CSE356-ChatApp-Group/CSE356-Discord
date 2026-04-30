/**
 * POST /presence/bulk — bulk status lookup via request body
 */

import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../../types/http";

const presence = require("../service");

const PRESENCE_BULK_MAX_IDS = 2000;

function normalizeUserIds(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [];
  const ids = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return Array.from(new Set(ids)).slice(0, PRESENCE_BULK_MAX_IDS);
}

module.exports = function registerPresencePostBulkRoute(router: import("express").IRouter) {
  router.post("/bulk", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const ids = normalizeUserIds(req.body?.userIds);
      if (!ids.length) return res.status(400).json({ error: "userIds body field required" });
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

