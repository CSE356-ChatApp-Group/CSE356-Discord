/**
 * RUM (real user metrics) — `limiter.ts` + `routes/postMetrics.ts`.
 */

const express = require("express");

const { rumLimiterOrPassthrough } = require("./limiter");
const rumPostHandler = require("./routes/postMetrics");

const router = express.Router();
router.post("/rum", rumLimiterOrPassthrough(), express.json({ limit: "16kb" }), rumPostHandler);

module.exports = router;
