/**
 * PUT /presence — set own status
 */

import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../../types/http";

const presence = require("../service");

module.exports = function registerPresencePutRoute(router: import("express").IRouter) {
  router.put("/", async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const { status, awayMessage } = req.body || {};
      const allowed = ["online", "idle", "away"];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${allowed.join(", ")}` });
      }
      if (awayMessage !== undefined && typeof awayMessage !== "string" && awayMessage !== null) {
        return res.status(400).json({ error: "awayMessage must be a string or null" });
      }
      await presence.syncConnectionStatuses(req.user.id, status);
      await presence.setPresence(req.user.id, status, status === "away" ? awayMessage : null);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });
};
