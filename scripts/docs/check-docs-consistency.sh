#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== Docs consistency checks =="

# 1) Prevent stale references after markdown renames.
OLD_REF_PATTERN='RUNBOOKS\.md|GRADING-DELIVERY-SEMANTICS\.md|SLOS-AND-CHAOS\.md|VERIFICATION-RISK-REGISTER\.md|DEPLOYMENT_RUNBOOK\.md|DEPLOYMENT-POLICY\.md|STAGING-DRILL-CHECKLIST\.md'
if rg -n "$OLD_REF_PATTERN" . >/tmp/docs_old_refs.txt; then
  echo "Found stale documentation filename references:"
  cat /tmp/docs_old_refs.txt
  exit 1
fi

# 2) Operational docs must carry lightweight metadata.
required_docs=(
  "docs/agent-operations-playbook.md"
  "docs/env.md"
  "docs/architecture/grading-delivery-semantics.md"
  "docs/infrastructure-inventory.md"
  "docs/operations-monitoring.md"
  "docs/architecture/realtime-delivery-contract.md"
  "docs/runbooks.md"
  "docs/architecture/websocket-generated-client-parity.md"
)

for file in "${required_docs[@]}"; do
  for needle in "Status:" "Owner:" "Last reviewed:"; do
    if ! rg -n "^${needle}" "$file" >/dev/null; then
      echo "Missing '${needle}' metadata in ${file}"
      exit 1
    fi
  done
done

echo "Docs checks passed."
