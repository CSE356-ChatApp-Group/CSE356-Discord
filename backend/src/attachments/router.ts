/**
 * Attachments API — mounts route modules under /api/v1/attachments.
 *
 * - `routes/presign.ts` — POST `/presign`
 * - `routes/create.ts` — POST `/`
 * - `routes/getOne.ts` — GET `/:id`
 */

const express = require("express");
const { authenticate } = require("../middleware/authenticate");

const registerAttachmentPresignRoutes = require("./routes/presign");
const registerAttachmentCreateRoutes = require("./routes/create");
const registerAttachmentGetRoutes = require("./routes/getOne");

const router = express.Router();
router.use(authenticate);

registerAttachmentPresignRoutes(router);
registerAttachmentCreateRoutes(router);
registerAttachmentGetRoutes(router);

module.exports = router;
