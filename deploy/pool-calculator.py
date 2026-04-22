#!/usr/bin/env python3
"""
Calculate optimal PgBouncer pool sizing based on VM specs and worker count.

This is the authoritative source for pool sizing calculation. Used by:
  - deploy-prod.sh (reads output to set PGBOUNCER_POOL_SIZE)
  - deploy/validate-deploy.sh (verifies actual vs expected)
  - Pre-flight checks (ensures adequate DB connections)

Formula:
  pool_size = max(60, min(500, (vCPU × 50) + ((workers - 1) × 30)))

Rationale:
  - Base: vCPU × 50 accounts for baseline connection overhead per core
  - Per-worker: (workers - 1) × 30 accounts for burst connection usage
  - Per-instance limit: 500 (never over-provision PgBouncer)
  - Floor: 60 (minimum viable pool for async workloads)

Examples:
  - 8vCPU, 4 workers (VM1): (8×50) + (3×30) = 490 pool
  - 8vCPU, 6 workers (VM2): (8×50) + (5×30) = 550 → capped at 500
  - 4vCPU, 2 workers:       (4×50) + (1×30) = 230 pool
"""

import argparse
import sys


def calculate_pool_size(vcpu: int, workers: int, explain: bool = False) -> int:
    """Calculate optimal pool size for given VM specs."""
    cpu_part = vcpu * 50
    extra = max(0, workers - 1) * 30
    pool_size = max(60, min(500, cpu_part + extra))

    if explain:
        print(f"Pool Sizing Calculation:")
        print(f"  vCPU: {vcpu}")
        print(f"  Workers: {workers}")
        print(f"  Formula: max(60, min(500, (vCPU×50) + ((workers-1)×30)))")
        print(f"  CPU part: {vcpu}×50 = {cpu_part}")
        print(f"  Worker part: ({workers}-1)×30 = {extra}")
        print(f"  Sum: {cpu_part} + {extra} = {cpu_part + extra}")
        print(f"  After min(500): {min(500, cpu_part + extra)}")
        print(f"  After max(60): {pool_size}")

    return pool_size


def calculate_pg_max_connections(pool_size: int, headroom: int = 100, explain: bool = False) -> int:
    """Calculate PostgreSQL max_connections needed for the PgBouncer pool."""
    pg_max = max(150, min(1600, pool_size + headroom))

    if explain:
        print(f"PostgreSQL max_connections:")
        print(f"  Pool size: {pool_size}")
        print(f"  Headroom: {headroom} (for superuser, monitoring, stats)")
        print(f"  Formula: max(150, min(1600, pool_size + headroom))")
        print(f"  Calculation: max(150, min(1600, {pool_size} + {headroom}))")
        print(f"  Result: {pg_max}")

    return pg_max


def main():
    parser = argparse.ArgumentParser(
        description="Calculate PgBouncer pool sizing for ChatApp deployment."
    )
    parser.add_argument("--vcpu", type=int, required=True, help="VM vCPU count")
    parser.add_argument("--workers", type=int, required=True, help="Number of Node.js workers")
    parser.add_argument("--explain", action="store_true", help="Show calculation steps")
    parser.add_argument("--pg-headroom", type=int, default=100, help="PostgreSQL headroom (default: 100)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.vcpu < 1 or args.workers < 1:
        print("ERROR: vcpu and workers must be >= 1", file=sys.stderr)
        sys.exit(1)

    pool_size = calculate_pool_size(args.vcpu, args.workers, explain=args.explain)
    pg_max = calculate_pg_max_connections(pool_size, headroom=args.pg_headroom, explain=args.explain)

    if args.json:
        import json
        print(json.dumps({
            "vcpu": args.vcpu,
            "workers": args.workers,
            "pool_size": pool_size,
            "pg_max_connections": pg_max,
        }))
    elif not args.explain:
        print(pool_size)
    else:
        print(f"\n✓ Recommended PgBouncer pool_size: {pool_size}")
        print(f"✓ Recommended PostgreSQL max_connections: {pg_max}")


if __name__ == "__main__":
    main()
