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

## Notes for deploy/ops guidance

- Capacity comparisons should use staging app VM (8 vCPU) vs production app VM (8 vCPU).
- Staging default shape is dual-worker (`CHATAPP_INSTANCES=2`); for production worker-scaling experiments, temporarily match the intended prod worker count.
- Production app VM: Node HTTP workers may run as **four** processes (`chatapp@4000`–`4003`) when `CHATAPP_INSTANCES=4` / `CHATAPP_INSTANCES_PROD=4`; nginx `upstream app` lists all active ports.
- If infra changes, update this file and mention the date in the "Last updated" line.
