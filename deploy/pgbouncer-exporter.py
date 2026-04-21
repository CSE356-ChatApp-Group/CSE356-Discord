#!/usr/bin/env python3
"""
Simple PgBouncer metrics exporter for Prometheus.

Queries PgBouncer's SHOW STATS and SHOW POOLS commands and exposes them
as Prometheus metrics. Listens on :9126/metrics by default.

Uses psql subprocess for compatibility with minimal dependencies.

Usage:
  python3 pgbouncer-exporter.py [--listen 0.0.0.0:9126] [--pgbouncer 127.0.0.1:6432]
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

# Global state for metrics
metrics_cache = {}
metrics_timestamp = 0
CACHE_TTL = 10  # seconds


def query_pgbouncer(host, port, sql):
    """Query PgBouncer using psql; return list of dicts."""
    try:
        result = subprocess.run(
            [
                "psql",
                "-h", host,
                "-p", str(port),
                "-U", "chatapp",  # stats_users = chatapp in pgbouncer.ini
                "-d", "pgbouncer",
                "-A",  # unaligned output
                "-t",  # tuples only (no headers/footers)
                "-F", "|",  # field separator
                "-c", sql,
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            raise RuntimeError(f"psql error: {result.stderr}")

        # Parse output
        rows = []
        lines = result.stdout.strip().split("\n")
        for line in lines:
            if not line:
                continue
            rows.append(line.split("|"))
        return rows
    except subprocess.TimeoutExpired:
        raise ConnectionError(f"Connection to PgBouncer at {host}:{port} timed out")
    except Exception as e:
        raise ConnectionError(f"Failed to query PgBouncer at {host}:{port}: {e}")


def fetch_metrics(pgbouncer_host, pgbouncer_port):
    """Fetch and parse PgBouncer metrics."""
    global metrics_cache, metrics_timestamp

    now = time.time()
    if now - metrics_timestamp < CACHE_TTL and metrics_cache:
        return metrics_cache

    metrics = {}

    try:
        # SHOW STATS — connection pool statistics
        # Columns: database|total_xact_count|total_query_count|total_received|total_sent|total_xact_time|total_query_time|total_wait_time|...
        stats_rows = query_pgbouncer(pgbouncer_host, pgbouncer_port, "SHOW STATS;")
        if stats_rows:
            for row in stats_rows:
                if len(row) < 8:
                    continue
                database = row[0]
                if database == "pgbouncer":
                    continue  # Skip internal pgbouncer database

                labels = f'database="{database}"'

                try:
                    total_xact_count = int(row[1])
                    total_query_count = int(row[2])
                    total_xact_time = int(row[5])  # microseconds
                    total_query_time = int(row[6])  # microseconds
                    total_wait_time = int(row[7])  # microseconds

                    metrics[f"pgbouncer_stats_xact_count_total{{db={labels}}}"] = total_xact_count
                    metrics[f"pgbouncer_stats_query_count_total{{db={labels}}}"] = total_query_count
                    metrics[f"pgbouncer_stats_xact_time_seconds{{db={labels}}}"] = total_xact_time / 1000000.0
                    metrics[f"pgbouncer_stats_query_time_seconds{{db={labels}}}"] = total_query_time / 1000000.0
                    metrics[f"pgbouncer_stats_wait_time_seconds{{db={labels}}}"] = total_wait_time / 1000000.0
                except (ValueError, IndexError):
                    pass

        # SHOW POOLS — per-pool connection statistics
        # Columns: database|user|cl_active|cl_waiting|cl_active_cancel_req|cl_waiting_cancel_req|sv_active|sv_active_cancel|sv_being_canceled|sv_idle|sv_used|sv_tested|sv_login|maxwait|maxwait_us|pool_mode
        pool_rows = query_pgbouncer(pgbouncer_host, pgbouncer_port, "SHOW POOLS;")
        if pool_rows:
            for row in pool_rows:
                if len(row) < 13:
                    continue
                database = row[0]
                if database == "pgbouncer":
                    continue  # Skip internal pgbouncer database

                labels = f'database="{database}"'

                try:
                    cl_active = int(row[2])
                    cl_waiting = int(row[3])
                    sv_active = int(row[6])
                    sv_idle = int(row[9])
                    sv_used = int(row[10])
                    sv_tested = int(row[11])
                    sv_login = int(row[12])

                    metrics[f"pgbouncer_client_active{{db={labels}}}"] = cl_active
                    metrics[f"pgbouncer_client_waiting{{db={labels}}}"] = cl_waiting
                    metrics[f"pgbouncer_server_active{{db={labels}}}"] = sv_active
                    metrics[f"pgbouncer_server_idle{{db={labels}}}"] = sv_idle
                    metrics[f"pgbouncer_server_used{{db={labels}}}"] = sv_used
                    metrics[f"pgbouncer_server_tested{{db={labels}}}"] = sv_tested
                    metrics[f"pgbouncer_server_login{{db={labels}}}"] = sv_login
                    metrics[f"pgbouncer_queue_depth{{db={labels}}}"] = cl_waiting
                except (ValueError, IndexError):
                    pass

        metrics_cache = metrics
        metrics_timestamp = now

    except Exception as e:
        print(f"Error fetching metrics: {e}", file=sys.stderr)
        if not metrics_cache:
            metrics_cache = {}

    return metrics



class MetricsHandler(BaseHTTPRequestHandler):
    pgbouncer_host = "127.0.0.1"
    pgbouncer_port = 6432

    def do_GET(self):
        if self.path == "/metrics":
            try:
                metrics = fetch_metrics(self.pgbouncer_host, self.pgbouncer_port)

                # Build response with proper Prometheus format
                lines = []
                lines.append("# HELP pgbouncer_client_active Number of active client connections")
                lines.append("# TYPE pgbouncer_client_active gauge")
                lines.append("# HELP pgbouncer_client_waiting Number of waiting client connections")
                lines.append("# TYPE pgbouncer_client_waiting gauge")
                lines.append("# HELP pgbouncer_server_active Number of active server connections")
                lines.append("# TYPE pgbouncer_server_active gauge")
                lines.append("# HELP pgbouncer_queue_depth Number of clients waiting for a server connection")
                lines.append("# TYPE pgbouncer_queue_depth gauge")
                lines.append("# HELP pgbouncer_up Whether PgBouncer is reachable")
                lines.append("# TYPE pgbouncer_up gauge")

                for metric_name, value in sorted(metrics.items()):
                    lines.append(f"{metric_name} {value}")

                # Add up metric
                lines.append('pgbouncer_up 1')

                response = "\n".join(lines) + "\n"

                self.send_response(200)
                self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
                self.send_header("Content-Length", str(len(response.encode())))
                self.end_headers()
                self.wfile.write(response.encode())
            except Exception as e:
                print(f"Error handling /metrics: {e}", file=sys.stderr)
                self.send_response(500)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Internal server error\n")
        elif self.path == "/-/healthy":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"OK\n")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        # Suppress default HTTP logging
        pass


def main():
    parser = argparse.ArgumentParser(description="PgBouncer Prometheus exporter")
    parser.add_argument(
        "--listen",
        default="0.0.0.0:9126",
        help="Address and port to listen on (default: 0.0.0.0:9126)",
    )
    parser.add_argument(
        "--pgbouncer",
        default="127.0.0.1:6432",
        help="PgBouncer address:port (default: 127.0.0.1:6432)",
    )
    args = parser.parse_args()

    listen_host, listen_port = args.listen.split(":")
    pgbouncer_host, pgbouncer_port = args.pgbouncer.split(":")

    MetricsHandler.pgbouncer_host = pgbouncer_host
    MetricsHandler.pgbouncer_port = pgbouncer_port

    server = HTTPServer((listen_host, int(listen_port)), MetricsHandler)
    print(f"PgBouncer exporter listening on {listen_host}:{listen_port}", file=sys.stderr)
    print(f"PgBouncer target: {pgbouncer_host}:{pgbouncer_port}", file=sys.stderr)
    print(f"Metrics available at http://{listen_host}:{listen_port}/metrics", file=sys.stderr)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...", file=sys.stderr)
        server.shutdown()


if __name__ == "__main__":
    main()

