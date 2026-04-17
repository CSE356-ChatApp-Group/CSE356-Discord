#!/usr/bin/env bash
# Post-merge operator checklist for Wave 2 (realtime + user_only profile).
# Does not SSH or deploy; prints steps only. CI already ran backend tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo '<unknown>')"
echo "Tip of main (deploy after CI green): $SHA"
echo ""
cat <<'EOF'
Wave 2 rollout — operator steps (after merge to main and CI release artifact exists)

Staging (first):
  1. GitHub Actions → Manual Deploy → environment staging → SHA = printed above.
  2. Smoke: curl https://<staging-host>/health ; spot-check OAuth + WS.
  3. Watch ~30–60m: Redis load, fanout_publish_duration_ms, realtime_passthrough_publish_skipped_total, pool waiting.
  4. Rollback staging: Manual Deploy same workflow with previous known-good SHA.

Production (after staging looks good):
  1. Manual Deploy → prod → same SHA as validated staging (required env includes WS_AUTO_SUBSCRIBE_MODE=user_only).
  2. First 2–5 minutes may show a single grader delivery blip during cutover; judge sustained regressions over 30–60+ minutes.
  3. Monitor: artifacts/rollout-monitoring/grader-watch-events.jsonl (Delivery timeout), metrics above, nginx 5xx, OAuth errors.
  4. Rollback prod: Manual Deploy previous SHA (reverts code + deploy/env profiles from git).

Local verification already expected in CI:
  npm --prefix backend test -- websocket.test.ts messages.test.ts
  npm --prefix backend test -- oauth-course-callback.test.ts grader-parity.test.ts auth.test.ts
EOF
