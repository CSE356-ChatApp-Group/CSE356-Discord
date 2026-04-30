/**
 * POST /rum — client RUM batch ingest (handler only; limiter + json applied in router).
 */

const {
  clientWebVitalTimingSeconds,
  clientWebVitalClsScore,
  clientRumBatchesTotal,
} = require("../../utils/metrics");

const TIMING_NAMES = new Set(["LCP", "INP", "FCP", "TTFB"]);

module.exports = function rumPostHandler(req: any, res: any) {
  const metrics = req.body?.metrics;
  if (!Array.isArray(metrics)) {
    return res.status(400).json({ error: "metrics array required" });
  }
  for (const m of metrics) {
    if (!m || typeof m !== "object") continue;
    const name = String(m.name || "").toUpperCase();
    const value = Number(m.value);
    if (!Number.isFinite(value)) continue;
    if (name === "CLS") {
      clientWebVitalClsScore.observe({ name: "CLS" }, Math.min(Math.max(value, 0), 10));
    } else if (TIMING_NAMES.has(name)) {
      clientWebVitalTimingSeconds.observe({ name }, value / 1000);
    }
  }
  clientRumBatchesTotal.inc();
  return res.status(204).end();
};
