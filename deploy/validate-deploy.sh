#!/bin/bash
# deploy/validate-deploy.sh
# Pre-flight validation before deploying to production.
#
# Usage:
#   ./deploy/validate-deploy.sh --prod     # Check prod VM1
#   ./deploy/validate-deploy.sh --host 130.245.136.44 --workers 4 --vcpu 8

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POOL_CALC="${SCRIPT_DIR}/pool-calculator.py"

PROD_HOST="130.245.136.44"
PROD_USER="ubuntu"
DB_HOST="130.245.136.21"
DB_USER="ubuntu"
VCPU=8
WORKERS=4

while [[ $# -gt 0 ]]; do
  case $1 in
    --host) PROD_HOST="$2"; shift 2 ;;
    --vcpu) VCPU="$2"; shift 2 ;;
    --workers) WORKERS="$2"; shift 2 ;;
    --db) DB_HOST="$2"; shift 2 ;;
    --prod) PROD_HOST="130.245.136.44"; VCPU=8; WORKERS=4; shift ;;
    *) echo "Unknown: $1" >&2; exit 1 ;;
  esac
done

echo "=== Pre-Deploy Validation ==="
echo "Target: $PROD_USER@$PROD_HOST (vCPU=$VCPU, workers=$WORKERS)"

# Calculate expected sizing
POOL_SIZE=$("$POOL_CALC" --vcpu=$VCPU --workers=$WORKERS)
PG_MAX=$("$POOL_CALC" --vcpu=$VCPU --workers=$WORKERS --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["pg_max_connections"])')
echo "Expected: pool_size=$POOL_SIZE, pg_max_connections >= $PG_MAX"
echo ""

# Check 1: SSH connectivity
echo "✓ Connectivity check..."
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$PROD_USER@$PROD_HOST" "echo OK" >/dev/null 2>&1 || { echo "  ✗ Cannot reach $PROD_HOST"; exit 1; }
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$DB_USER@$DB_HOST" "echo OK" >/dev/null 2>&1 || { echo "  ✗ Cannot reach $DB_HOST"; exit 1; }

# Check 2: PostgreSQL max_connections
echo "✓ PostgreSQL configuration..."
ACTUAL=$( ssh "$DB_USER@$DB_HOST" "sudo -u postgres psql -qAt -c 'SHOW max_connections;'" 2>/dev/null | tr -d ' ')
if [ "$ACTUAL" -lt "$PG_MAX" ]; then
  echo "  ✗ PostgreSQL max_connections=$ACTUAL, need >= $PG_MAX"
  echo "  Run: DB_SSH=$DB_USER@$DB_HOST ALLOW_DB_RESTART=true ./deploy/tune-remote-db-postgres.sh"
  exit 1
fi
echo "  Found: max_connections=$ACTUAL (good)"

# Check 3: Disk space
echo "✓ Disk space check..."
DISK=$(ssh "$PROD_USER@$PROD_HOST" "df -BG /opt/chatapp 2>/dev/null | tail -1 | awk '{print \$4}'" | sed 's/G//')
if [ "$DISK" -lt 10 ]; then
  echo "  ✗ Only ${DISK}GB available"
  exit 1
fi
echo "  Found: ${DISK}GB available"

echo ""
echo "✅ All checks passed! Ready to deploy."
