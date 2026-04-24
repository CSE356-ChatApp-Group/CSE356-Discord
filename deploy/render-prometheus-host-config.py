#!/usr/bin/env python3
"""Expand prometheus-host.yml placeholders for the monitoring-VM Prometheus (scrapes all app VMs).

Replaces:
  __PROM_REDIS_HOST__            — private IP/hostname of the Redis VM for redis_exporter scrape
  __CHATAPP_API_STATIC_CONFIGS__ — one chatapp-api scrape target per HTTP worker (4000..)
  __NODE_EXPORTER_TARGETS__      — node_exporter targets for all app VMs (with vm label in multi-VM)
  __PGBOUNCER_TARGETS__          — pgbouncer-exporter targets for all app VMs

Single-VM mode (default, backward-compatible):
    render-prometheus-host-config.py --template ... --output ... --app-host IP --workers N

Multi-VM mode (three app VMs, per-VM PgBouncer architecture):
    render-prometheus-host-config.py --template ... --output ... \\
        --app-host VM1_IP --vm1-workers 4 \\
        --vm2-host VM2_IP --vm2-workers 6 \\
        --vm3-host VM3_IP --vm3-workers 6
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


def _api_block(host: str, workers: int, vm_label: str) -> str:
    if workers < 1:
        raise SystemExit("--workers must be >= 1")
    lines: list[str] = []
    for i in range(workers):
        port = 4000 + i
        lines.append(f"      - targets: ['{host}:{port}']")
        lines.append("        labels:")
        lines.append(f"          vm: {vm_label}")
        lines.append(f"          worker_port: '{port}'")
        lines.append(f"          node: {_node_label(port)}")
    return "\n".join(lines) + "\n"


def _api_block_multi_vm(hosts_and_workers: list[tuple[str, int, str]]) -> str:
    """Generate chatapp-api scrape targets for multiple VMs.

    Args:
        hosts_and_workers: list of (host, worker_count, vm_label) tuples
        Example: [("10.0.0.237", 4, "vm1"), ("10.0.3.243", 6, "vm2"), ("10.0.2.164", 6, "vm3")]
    """
    lines: list[str] = []
    for host, workers, vm_label in hosts_and_workers:
        if workers < 1:
            continue
        for i in range(workers):
            port = 4000 + i
            lines.append(f"      - targets: ['{host}:{port}']")
            lines.append("        labels:")
            lines.append(f"          vm: {vm_label}")
            lines.append(f"          worker_port: '{port}'")
            lines.append(f"          node: {_node_label(port)}")
    return "\n".join(lines) + "\n"


def _node_exporter_targets(hosts_and_labels: list[tuple[str, str]]) -> str:
    """Generate node_exporter static_configs targets, one per app VM.

    Args:
        hosts_and_labels: list of (host_ip, vm_label) tuples
        Example: [("10.0.0.237", "vm1"), ("10.0.3.243", "vm2"), ("10.0.2.164", "vm3")]
    """
    lines: list[str] = []
    for host, label in hosts_and_labels:
        lines.append(f"      - targets: ['{host}:9100']")
        lines.append("        labels:")
        lines.append(f"          vm: {label}")
    return "\n".join(lines) + "\n"


def _pgbouncer_targets(hosts_and_labels: list[tuple[str, str]]) -> str:
    """Generate pgbouncer-exporter static_configs targets, one per app VM.

    Args:
        hosts_and_labels: list of (host_ip, vm_label) tuples
    """
    lines: list[str] = []
    for host, label in hosts_and_labels:
        lines.append(f"      - targets: ['{host}:9126']")
        lines.append("        labels:")
        lines.append(f"          vm: {label}")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--template", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--app-host", required=True, help="VM1 private IP (always required)")
    ap.add_argument(
        "--redis-host",
        default="",
        help="Redis VM private IP for redis_exporter scrape (defaults to --app-host)",
    )
    ap.add_argument("--workers", type=int, default=0, help="VM1 worker count (single-VM mode)")
    ap.add_argument("--vm1-workers", type=int, default=0, help="VM1 worker count (multi-VM mode)")
    ap.add_argument("--vm2-host", default="", help="VM2 private IP (multi-VM mode)")
    ap.add_argument("--vm2-workers", type=int, default=0, help="VM2 worker count (multi-VM mode)")
    ap.add_argument("--vm3-host", default="", help="VM3 private IP (multi-VM mode)")
    ap.add_argument("--vm3-workers", type=int, default=0, help="VM3 worker count (multi-VM mode)")
    args = ap.parse_args()

    text = args.template.read_text(encoding="utf-8")
    if "__CHATAPP_API_STATIC_CONFIGS__" not in text:
        raise SystemExit("template missing __CHATAPP_API_STATIC_CONFIGS__ marker")
    if "__PROM_REDIS_HOST__" not in text:
        raise SystemExit("template missing __PROM_REDIS_HOST__ marker")
    if "__NODE_EXPORTER_TARGETS__" not in text:
        raise SystemExit("template missing __NODE_EXPORTER_TARGETS__ marker")
    if "__PGBOUNCER_TARGETS__" not in text:
        raise SystemExit("template missing __PGBOUNCER_TARGETS__ marker")

    # Multi-VM mode: --vm1-workers triggers it; falls back to single-VM if only --workers given
    vm1_workers = args.vm1_workers if args.vm1_workers > 0 else args.workers
    multi_vm = args.vm1_workers > 0

    if multi_vm:
        hosts_and_workers = [(args.app_host, args.vm1_workers, "vm1")]
        if args.vm2_host and args.vm2_workers > 0:
            hosts_and_workers.append((args.vm2_host, args.vm2_workers, "vm2"))
        if args.vm3_host and args.vm3_workers > 0:
            hosts_and_workers.append((args.vm3_host, args.vm3_workers, "vm3"))
        api_config = _api_block_multi_vm(hosts_and_workers)

        # Build (host, label) pairs for node_exporter and pgbouncer
        node_hosts = [(host, vm_label) for host, _, vm_label in hosts_and_workers]
        node_config = _node_exporter_targets(node_hosts)
        pgb_config = _pgbouncer_targets(node_hosts)
    else:
        if vm1_workers < 1:
            raise SystemExit("--workers (or --vm1-workers) must be >= 1")
        api_config = _api_block(args.app_host, vm1_workers, "vm1")
        node_config = _node_exporter_targets([(args.app_host, "vm1")])
        pgb_config = _pgbouncer_targets([(args.app_host, "vm1")])

    redis_host = args.redis_host or args.app_host

    text = text.replace("__CHATAPP_API_STATIC_CONFIGS__", api_config)
    text = text.replace("__PROM_REDIS_HOST__", redis_host)
    text = text.replace("__NODE_EXPORTER_TARGETS__", node_config)
    text = text.replace("__PGBOUNCER_TARGETS__", pgb_config)
    args.output.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
