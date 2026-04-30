/**
 * POST /attachments/presign
 */

import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../../types/http";

const { randomUUID } = require("crypto");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { body, validationResult } = require("express-validator");

const overload = require("../../utils/overload");
const {
  s3Presign,
  BUCKET,
  toClientFacingUrl,
  assertDirectPresignedUrlMatchesSigner,
} = require("../storage");
const {
  ALLOWED_TYPES,
  PRESIGN_UNSIGNABLE_HEADERS,
} = require("../constants");

module.exports = function registerAttachmentPresignRoutes(router: import("express").IRouter) {
  router.post(
    "/presign",
    body("filename").isString(),
    body("contentType").isIn([...ALLOWED_TYPES]),
    body("sizeBytes").isInt({ min: 1 }),
    body("messageId").optional().isUUID(),
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      if (overload.shouldDeferSearchIndexing()) {
        res.set("Retry-After", "5");
        return res.status(503).json({ error: "Server busy, please retry" });
      }

      try {
        const { filename, contentType, sizeBytes } = req.body;
        const ext = filename.split(".").pop().toLowerCase();
        const key = `uploads/${req.user.id}/${randomUUID()}.${ext}`;

        const cmd = new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          ContentType: contentType,
        });

        const url = toClientFacingUrl(
          await getSignedUrl(s3Presign, cmd, {
            expiresIn: 300,
            unsignableHeaders: PRESIGN_UNSIGNABLE_HEADERS,
          }),
        );
        assertDirectPresignedUrlMatchesSigner(url);

        res.json({ uploadUrl: url, storageKey: key });
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message?: string };
        if (e && e.statusCode === 500 && e.message) {
          return res.status(500).json({ error: e.message });
        }
        next(err);
      }
    },
  );
};
