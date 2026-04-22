#!/usr/bin/env python3
"""
Structured logging for deployment scripts.

Logs all deployment decisions to JSON file for audit trail and debugging.
Used by: deploy-prod.sh

Example:
  ./deploy/record-deploy-event.py \\
    --release e0c97f7 \\
    --phase "pool-sizing" \\
    --status "calculated" \\
    --data '{"pool_size": 490, "vcpu": 8, "workers": 4}'
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def log_event(
    release: str,
    phase: str,
    status: str,
    data: dict = None,
    vm: str = "unknown",
    log_dir: str = "/opt/chatapp/logs"
):
    """Log a deployment event to structured JSON log."""
    Path(log_dir).mkdir(parents=True, exist_ok=True)

    log_file = Path(log_dir) / f"deploy-{release[:12]}.jsonl"

    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "release": release[:12],
        "phase": phase,
        "status": status,
        "vm": vm,
        "data": data or {},
    }

    # Append to log file (JSONL format - one JSON object per line)
    with open(log_file, "a") as f:
        f.write(json.dumps(event) + "\n")

    # Also print for immediate visibility
    print(f"[{phase}] {status}")
    if data:
        for key, value in data.items():
            print(f"  {key}: {value}")

    return log_file


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Log deployment event")
    parser.add_argument("--release", required=True, help="Release SHA")
    parser.add_argument("--phase", required=True, help="Deployment phase")
    parser.add_argument("--status", required=True, help="Status/action")
    parser.add_argument("--data", default="{}", help="JSON data dict")
    parser.add_argument("--vm", default="unknown", help="VM name/host")
    parser.add_argument("--log-dir", default="/opt/chatapp/logs", help="Log directory")

    args = parser.parse_args()

    try:
        data = json.loads(args.data) if args.data != "{}" else {}
        log_event(
            release=args.release,
            phase=args.phase,
            status=args.status,
            data=data,
            vm=args.vm,
            log_dir=args.log_dir,
        )
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
