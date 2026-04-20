# Infrastructure Inventory

Last updated: 2026-04-20

This is the source of truth for current environment shape. Update this file whenever VM sizing, hosts, or provider changes.

## Staging hosts

- Staging app VM (`staging-vm`, GCP Compute Engine): `e2-standard-8` (8 vCPU, 32 GB RAM). External IP **`136.114.103.71`**, internal IP **`10.128.0.2`**, SSH user **`ssperrottet`**.
- Staging DB VM (`staging-db`, GCP Compute Engine): Debian 12, 8 vCPU, 8 GB RAM. External IP **`34.122.64.224`**, internal IP **`10.128.0.5`**, SSH user **`ssperrottet`**. PostgreSQL 16, database `chatapp_prod`, credentials at `/root/chatapp_prod_db_credentials.txt` (root-only, chmod 600). Same **Docker monitoring stack** as prod DB (`db-compose.yml`): Grafana, Prometheus, Alertmanager, Loki, Tempo; app VM runs only node-exporter + promtail (Loki push URL `10.128.0.5` in `promtail-host-config-staging.yml`).

**CI runners:** GitHub Actions uses GitHub-hosted `ubuntu-latest` runners. Former self-hosted GCP runner VMs have been decommissioned/repurposed (`34.122.64.224` → staging DB VM).

## Production hosts

- Monitoring VM (Linode): external **`130.245.136.120`**, internal **`10.0.1.102`**. Runs the **Docker monitoring stack** (Grafana, Prometheus, Alertmanager, **Loki**, Tempo, etc.). **Loki** listens on **`10.0.1.102:3100`** (and on the host); Promtail on app VMs pushes here. Grafana uses host networking and talks to Loki at **`http://127.0.0.1:3100`** on this machine.
- App VMs (`ubuntu-intelbroadwell`, Linode): **three** app/proxy hosts — **`130.245.136.44`** (vm1), **`130.245.136.137`** (vm2), **`130.245.136.54`** (vm3), each 8 vCPU, 16 GB RAM. Monitoring on each is **node-exporter**, **Promtail** (logs to Loki on the monitoring VM at **`http://10.0.1.102:3100`**; `external_labels.host` is **`vm1`** / **`vm2`** in `promtail-host-config.yml`, **`vm3`** uses `infrastructure/monitoring/promtail-host-config-vm3.yml` with journal + nginx), and **redis_exporter** where deployed — not Grafana/Prometheus/Alertmanager on the app hosts.
- Database VM (`ubuntu-intelbroadwell-001`, Linode): `130.245.136.21`, internal **`10.0.1.62`**, 8 vCPU, 16 GB RAM. PostgreSQL 16 primary runs from the attached **100 GB NVMe volume** mounted at `/mnt/DB-NVMe` with data directory `/mnt/DB-NVMe/16/nvme` on port `5432`. The previous **50 GB HDD-backed** PostgreSQL volume may remain attached at `/var/lib/postgresql/16/main` as a rollback reference until you delete it after a stable cutover. **Grafana, Prometheus, Alertmanager, and Tempo** still run in Docker via **`db-compose.yml`** on this host; **Loki has been migrated off** this VM (the `loki` service is stopped; data volume retained for rollback). Host `:9100` / `:9187` metrics use systemd exporters from `deploy/install-db-metrics-exporters.sh` (not a duplicate Docker node-exporter). **`/opt/chatapp-monitoring/promtail-host-config.yml`** points at the monitoring VM Loki URL so Promtail is safe if re-enabled here.

**Latency / 5xx bottleneck (typical):** end-user and grader slowness under load most often traces to **PostgreSQL** (long queries, lock contention) and **per-Node connection pools** to PgBouncer/Postgres (`query timeout`, `pg_pool_waiting`, pool circuit breaker / **503**). The app and Redis CPU can look busy but are usually **symptoms**; confirm with DB metrics, `pg_stat_statements`, and app metrics in [operations-monitoring.md](operations-monitoring.md).

## Notes for deploy/ops guidance

- Capacity comparisons should use staging app VM (8 vCPU) vs production app VM (8 vCPU).
- Staging default shape is dual-worker (`CHATAPP_INSTANCES=2`); for production worker-scaling experiments, temporarily match the intended prod worker count.
- Production app VM: `deploy-prod.sh` defaults to **`CHATAPP_INSTANCES=5`** — five Node workers **`chatapp@4000`–`chatapp@4004`**; nginx `upstream app` lists all active ports. Prometheus on the DB VM scrapes **`/metrics` on each configured port** (see `deploy/render-prometheus-host-config.py`).
- If infra changes, update this file and mention the date in the "Last updated" line.
