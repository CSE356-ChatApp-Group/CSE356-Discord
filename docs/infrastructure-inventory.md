# Infrastructure Inventory

Last updated: 2026-04-19

This is the source of truth for current environment shape. Update this file whenever VM sizing, hosts, or provider changes.

## Staging hosts

- Staging app VM (`staging-vm`, GCP Compute Engine): `e2-standard-8` (8 vCPU, 32 GB RAM). External IP **`136.114.103.71`**, internal IP **`10.128.0.2`**, SSH user **`ssperrottet`**.
- Staging DB VM (`staging-db`, GCP Compute Engine): Debian 12, 8 vCPU, 8 GB RAM. External IP **`34.122.64.224`**, internal IP **`10.128.0.5`**, SSH user **`ssperrottet`**. PostgreSQL 16, database `chatapp_prod`, credentials at `/root/chatapp_prod_db_credentials.txt` (root-only, chmod 600). Same **Docker monitoring stack** as prod DB (`db-compose.yml`): Grafana, Prometheus, Alertmanager, Loki, Tempo; app VM runs only node-exporter + promtail (Loki push URL `10.128.0.5` in `promtail-host-config-staging.yml`).

**CI runners:** GitHub Actions uses GitHub-hosted `ubuntu-latest` runners. Former self-hosted GCP runner VMs have been decommissioned/repurposed (`34.122.64.224` → staging DB VM).

## Production hosts

- App/proxy VM (`ubuntu-intelbroadwell`, Linode): `130.245.136.44`, 8 vCPU, 16 GB RAM. Monitoring here is **node-exporter**, **promtail** (logs to Loki on the DB VM), and **redis_exporter** only — not Grafana/Prometheus/Alertmanager.
- Database VM (`ubuntu-intelbroadwell-001`, Linode): `130.245.136.21`, 8 vCPU, 16 GB RAM. **Grafana, Prometheus, Alertmanager, Loki, and Tempo** run in Docker (`db-compose.yml`). Host `:9100` / `:9187` metrics use systemd exporters from `deploy/install-db-metrics-exporters.sh` (not a duplicate Docker node-exporter).

**Latency / 5xx bottleneck (typical):** end-user and grader slowness under load most often traces to **PostgreSQL** (long queries, lock contention) and **per-Node connection pools** to PgBouncer/Postgres (`query timeout`, `pg_pool_waiting`, pool circuit breaker / **503**). The app and Redis CPU can look busy but are usually **symptoms**; confirm with DB metrics, `pg_stat_statements`, and app metrics in [operations-monitoring.md](operations-monitoring.md).

## Notes for deploy/ops guidance

- Capacity comparisons should use staging app VM (8 vCPU) vs production app VM (8 vCPU).
- Staging default shape is dual-worker (`CHATAPP_INSTANCES=2`); for production worker-scaling experiments, temporarily match the intended prod worker count.
- Production app VM: `deploy-prod.sh` defaults to **`CHATAPP_INSTANCES=5`** — five Node workers **`chatapp@4000`–`chatapp@4004`**; nginx `upstream app` lists all active ports. Prometheus on the DB VM scrapes **`/metrics` on each configured port** (see `deploy/render-prometheus-host-config.py`).
- If infra changes, update this file and mention the date in the "Last updated" line.
