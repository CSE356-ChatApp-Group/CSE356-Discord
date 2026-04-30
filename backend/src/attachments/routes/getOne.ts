/**
 * GET /attachments/:id
 */

import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../../types/http";

const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { param, validationResult } = require("express-validator");

const { BUCKET, toClientFacingUrl, assertDirectPresignedUrlMatchesSigner, s3Presign } = require("../storage");
const { loadAttachmentForUser } = require("../accessCache");
const { PRESIGN_UNSIGNABLE_HEADERS } = require("../constants");

module.exports = function registerAttachmentGetRoutes(router: import("express").IRouter) {
  router.get(
    "/:id",
    param("id").isUUID(),
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      try {
        const access = await loadAttachmentForUser(req.params.id, req.user.id);
        if (!access?.found) return res.status(404).json({ error: "Not found" });
        if (!access.allowed) return res.status(403).json({ error: "Access denied" });
        const attachment = access.attachment;

        const { channel_id, conversation_id, ...clientAttachment } = attachment;
        const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: attachment.storage_key });
        const url = toClientFacingUrl(
          await getSignedUrl(s3Presign, cmd, {
            expiresIn: 3600,
            unsignableHeaders: PRESIGN_UNSIGNABLE_HEADERS,
          }),
        );
        assertDirectPresignedUrlMatchesSigner(url);

        res.json({ attachment: clientAttachment, url });
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
