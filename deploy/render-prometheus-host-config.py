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


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--template", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--app-host", required=True, help="App VM address as seen from the Prometheus host")
    ap.add_argument("--workers", type=int, required=True, help="CHATAPP_INSTANCES (ports 4000..4000+N-1)")
    args = ap.parse_args()

    text = args.template.read_text(encoding="utf-8")
    if "__CHATAPP_API_STATIC_CONFIGS__" not in text:
        raise SystemExit("template missing __CHATAPP_API_STATIC_CONFIGS__ marker")
    if "__PROM_APP_HOST__" not in text:
        raise SystemExit("template missing __PROM_APP_HOST__ marker")

    text = text.replace("__CHATAPP_API_STATIC_CONFIGS__", _api_block(args.app_host, args.workers))
    text = text.replace("__PROM_APP_HOST__", args.app_host)
    args.output.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
