#!/usr/bin/env python3
"""
Record deployment configuration and state to /opt/chatapp/config/deployment-params.json

This script creates an audit trail of what was deployed, when, and with what config.
Helps with debugging "works on my machine" issues and understanding current state.

Used by: deploy-prod.sh (called at end of successful deployment)
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def get_git_info(release_sha: str) -> dict:
    """Get git commit info."""
    try:
        # Get commit message (first line only)
        msg = subprocess.check_output(
            ["git", "log", "--format=%B", "-n1", release_sha],
            text=True,
            stderr=subprocess.DEVNULL
        ).strip().split('\n')[0][:100]
    except:
        msg = "(unable to fetch)"

    return {
        "commit": release_sha[:12],
        "commit_full": release_sha,
        "message": msg,
    }


def record_deployment(
    release_sha: str,
    pool_size: int,
    pg_max_connections: int,
    workers: int,
    vcpu: int,
    deployed_by: str = "deploy-script",
    vm_name: str = "unknown"
):
    """Record deployment params to JSON file on target VM."""
    config_dir = Path("/opt/chatapp/config")
    config_file = config_dir / "deployment-params.json"

    # Create directory if needed
    config_dir.mkdir(parents=True, exist_ok=True)

    timestamp_iso = datetime.now(timezone.utc).isoformat()
    timestamp_unix = int(datetime.now(timezone.utc).timestamp())

    git_info = get_git_info(release_sha)

    # Build deployment record
    record = {
        "timestamp_iso": timestamp_iso,
        "timestamp_unix": timestamp_unix,
        "deployed_by": deployed_by,
        "vm_name": vm_name,
        "release": git_info,
        "configuration": {
            "pool_size": pool_size,
            "pg_max_connections": pg_max_connections,
            "workers": workers,
            "vcpu": vcpu,
        },
        "notes": f"Pool sizing: ({vcpu}vCPU × 50) + (({workers}-1) × 30) = {pool_size}",
    }

    # Read existing history if file exists
    history = []
    if config_file.exists():
        try:
            existing = json.loads(config_file.read_text())
            # Convert old single-record format to history array
            if isinstance(existing, dict) and "timestamp_iso" in existing:
                history = [existing]
            elif isinstance(existing, dict) and "history" in existing:
                history = existing.get("history", [])
            elif isinstance(existing, list):
                history = existing
        except json.JSONDecodeError:
            pass

    # Keep last 20 deployments (avoid unbounded growth)
    history = history[-19:] if len(history) >= 20 else history
    history.append(record)

    # Write with current deployment first (for quick lookup) + history
    output = {
        "current": record,
        "history": history,
    }

    config_file.write_text(json.dumps(output, indent=2))
    config_file.chmod(0o644)

    print(f"✓ Deployment config recorded to {config_file}")
    return config_file


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Record deployment configuration")
    parser.add_argument("--release", required=True, help="Release SHA")
    parser.add_argument("--pool-size", type=int, required=True, help="PgBouncer pool_size")
    parser.add_argument("--pg-max", type=int, required=True, help="PostgreSQL max_connections")
    parser.add_argument("--workers", type=int, required=True, help="Number of workers")
    parser.add_argument("--vcpu", type=int, required=True, help="VM vCPU count")
    parser.add_argument("--deployed-by", default="deploy-script", help="Who deployed this")
    parser.add_argument("--vm-name", default="unknown", help="VM hostname/name")

    args = parser.parse_args()

    try:
        record_deployment(
            release_sha=args.release,
            pool_size=args.pool_size,
            pg_max_connections=args.pg_max,
            workers=args.workers,
            vcpu=args.vcpu,
            deployed_by=args.deployed_by,
            vm_name=args.vm_name,
        )
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
