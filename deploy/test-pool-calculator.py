#!/usr/bin/env python3
"""
Integration tests for pool-calculator.py

Tests various VM configurations to ensure pool sizing is correct and doesn't regress.
Run with: python3 test-pool-calculator.py
"""

import json
import subprocess
import sys
from pathlib import Path


def run_calculator(vcpu: int, workers: int, json_output: bool = False) -> dict:
    """Run pool-calculator.py and return results."""
    script = Path(__file__).parent / "pool-calculator.py"
    cmd = [str(script), f"--vcpu={vcpu}", f"--workers={workers}"]
    if json_output:
        cmd.append("--json")

    result = subprocess.run(cmd, capture_output=True, text=True, check=True)

    if json_output:
        return json.loads(result.stdout)
    else:
        return {"pool_size": int(result.stdout.strip())}


def test_case(name: str, vcpu: int, workers: int, expected_pool: int, expected_pg_max: int):
    """Test a single configuration."""
    result = run_calculator(vcpu, workers, json_output=True)
    pool = result["pool_size"]
    pg_max = result["pg_max_connections"]

    status = "✓" if (pool == expected_pool and pg_max == expected_pg_max) else "✗"
    print(f"{status} {name}")
    if pool != expected_pool or pg_max != expected_pg_max:
        print(f"  Expected: pool={expected_pool}, pg_max={expected_pg_max}")
        print(f"  Got:      pool={pool}, pg_max={pg_max}")
        return False
    return True


def main():
    print("=== Pool Calculator Tests ===\n")

    tests = [
        # (name, vcpu, workers, expected_pool_size, expected_pg_max)
        ("VM1 prod (8vCPU, 4 workers)", 8, 4, 490, 590),
        ("VM2 prod (8vCPU, 6 workers)", 8, 6, 500, 600),
        ("VM3 prod (8vCPU, 6 workers)", 8, 6, 500, 600),
        ("Small VM (4vCPU, 2 workers)", 4, 2, 230, 330),
        ("Single worker (8vCPU, 1 worker)", 8, 1, 400, 500),
        ("Large VM (16vCPU, 8 workers)", 16, 8, 500, 600),  # Capped at 500
        ("Tiny VM (2vCPU, 1 worker)", 2, 1, 100, 200),  # Max(60, min(500, 100)) = 100
    ]

    passed = 0
    failed = 0

    for name, vcpu, workers, expected_pool, expected_pg_max in tests:
        try:
            if test_case(name, vcpu, workers, expected_pool, expected_pg_max):
                passed += 1
            else:
                failed += 1
        except Exception as e:
            print(f"✗ {name}")
            print(f"  ERROR: {e}")
            failed += 1

    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed")

    if failed > 0:
        print("\n⚠ Tests failed - check pool sizing formula")
        return 1

    print("\n✅ All pool sizing tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
