#!/usr/bin/env python3
"""Expand prometheus-host.yml placeholders for DB-VM Prometheus (scrapes app VM).

Replaces:
  __PROM_APP_HOST__              — private IP/hostname of the app VM (reachable from DB VM)
  __CHATAPP_API_STATIC_CONFIGS__ — one chatapp-api scrape target per HTTP worker (4000..)
"""
from __future__ import annotations

import argparse
from pathlib import Path


def _node_label(port: int) -> str:
    if port == 4000:
        return "live-4000"
    if port == 4001:
        return "candidate-4001"
    return f"worker-{port}"


def _api_block(host: str, workers: int) -> str:
    if workers < 1:
        raise SystemExit("--workers must be >= 1")
    lines: list[str] = []
    for i in range(workers):
        port = 4000 + i
        lines.append(f"      - targets: ['{host}:{port}']")
        lines.append("        labels:")
        lines.append(f"          node: {_node_label(port)}")
    return "\n".join(lines) + "\n"


def _api_block_multi_vm(hosts_and_workers: list[tuple[str, int]]) -> str:
    """Generate scrape targets for multiple VMs in per-VM PgBouncer architecture.

    Args:
        hosts_and_workers: list of (host, worker_count) tuples
        Example: [("10.0.0.237", 4), ("10.0.3.243", 6), ("10.0.2.164", 6)]
    """
    lines: list[str] = []
    for host, workers in hosts_and_workers:
        if workers < 1:
            continue
        for i in range(workers):
            port = 4000 + i
            lines.append(f"      - targets: ['{host}:{port}']")
            lines.append("        labels:")
            lines.append(f"          node: {_node_label(port)}")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--template", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--app-host", required=True, help="App VM address (single-VM mode)")
    ap.add_argument("--workers", type=int, required=True, help="CHATAPP_INSTANCES (single-VM mode)")
    ap.add_argument("--vm1-workers", type=int, default=0, help="VM1 worker count (multi-VM mode)")
    ap.add_argument("--vm2-host", default="", help="VM2 IP address (multi-VM mode)")
    ap.add_argument("--vm2-workers", type=int, default=0, help="VM2 worker count (multi-VM mode)")
    ap.add_argument("--vm3-host", default="", help="VM3 IP address (multi-VM mode)")
    ap.add_argument("--vm3-workers", type=int, default=0, help="VM3 worker count (multi-VM mode)")
    args = ap.parse_args()

    text = args.template.read_text(encoding="utf-8")
    if "__CHATAPP_API_STATIC_CONFIGS__" not in text:
        raise SystemExit("template missing __CHATAPP_API_STATIC_CONFIGS__ marker")
    if "__PROM_APP_HOST__" not in text:
        raise SystemExit("template missing __PROM_APP_HOST__ marker")

    # Detect multi-VM mode
    if args.vm1_workers > 0:
        hosts_and_workers = [(args.app_host, args.vm1_workers)]
        if args.vm2_host and args.vm2_workers > 0:
            hosts_and_workers.append((args.vm2_host, args.vm2_workers))
        if args.vm3_host and args.vm3_workers > 0:
            hosts_and_workers.append((args.vm3_host, args.vm3_workers))
        api_config = _api_block_multi_vm(hosts_and_workers)
    else:
        # Single-VM mode (backward compatible)
        api_config = _api_block(args.app_host, args.workers)

    text = text.replace("__CHATAPP_API_STATIC_CONFIGS__", api_config)
    text = text.replace("__PROM_APP_HOST__", args.app_host)
    args.output.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
