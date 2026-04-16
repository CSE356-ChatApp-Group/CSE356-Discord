# Infrastructure Inventory

Last updated: 2026-04-15

This is the source of truth for current environment shape. Update this file whenever VM sizing, hosts, or provider layout changes.

## Staging / CI hosts

- Staging app VM (`staging-vm`, GCP Compute Engine): `e2-standard-8` (8 vCPU, 32 GB RAM)
- GitHub Actions runner VM #1 (`github-actions-runner`, GCP Compute Engine): `c3-standard-4` (4 vCPU, 16 GB RAM)
- GitHub Actions runner VM #2 (GCP Compute Engine): `e2-standard-4` (4 vCPU, 16 GB RAM)

**Runner maintenance:** External IPs and SSH users live in GCP (not committed here). When CI logs show **low disk** or Chromium **Target crashed**, SSH to each runner VM as the runner user and run `scripts/self-hosted-actions-runner-disk-cleanup.sh` (report), then `RUNNER_PRUNE_CONFIRM=yes` between jobs. Staging app VM (`136.114.103.71`) is **not** the Actions runner; it has separate disk headroom.

## Production hosts

- App/proxy VM (`ubuntu-intelbroadwell`, Linode): `130.245.136.44`, 8 vCPU, 16 GB RAM
- Database VM (`ubuntu-intelbroadwell-001`, Linode): `130.245.136.21`, 8 vCPU, 16 GB RAM

## Notes for deploy/ops guidance

- Capacity comparisons should use staging app VM (8 vCPU) vs production app VM (8 vCPU).
- Staging default shape is dual-worker (`CHATAPP_INSTANCES=2`); for production worker-scaling experiments, temporarily match the intended prod worker count.
- Production app VM: Node HTTP workers may run as **four** processes (`chatapp@4000`–`4003`) when `CHATAPP_INSTANCES=4` / `CHATAPP_INSTANCES_PROD=4`; nginx `upstream app` lists all active ports.
- If infra changes, update this file and mention the date in the "Last updated" line.
