# Infrastructure Inventory

Last updated: 2026-04-16

This is the source of truth for current environment shape. Update this file whenever VM sizing, hosts, or provider layout changes.

## Staging / CI hosts

- Staging app VM (`staging-vm`, GCP Compute Engine): `e2-standard-8` (8 vCPU, 32 GB RAM)
- GitHub Actions runner VM #1 (`github-actions-runner`, GCP Compute Engine, zone `us-central1-b`): `c3-standard-4` (4 vCPU, 16 GB RAM). External IP **`34.122.64.224`**, SSH user **`ssperrottet`**.
- GitHub Actions runner VM #2 (`github-actions-runner-2`, GCP Compute Engine, zone `us-central1-b`): `e2-standard-4` (4 vCPU, 16 GB RAM). External IP **`104.197.225.4`**, SSH user **`ssperrottet`**.

Each runner has a **10 GiB boot** disk plus a **20 GiB data** disk mounted at **`/mnt/runner-data`** (`ext4`, `nofail` in `fstab`). **`~/actions-runner/_work`** and **`~/.cache/ms-playwright`** are symlinks into that volume so CI checkouts and Playwright browsers do not fill `/`.

**Runner maintenance:** When CI logs show **low disk** on `/` or Chromium **Target crashed**, SSH as `ssperrottet` and run `scripts/self-hosted-actions-runner-disk-cleanup.sh` (report), then `RUNNER_PRUNE_CONFIRM=yes` between jobs; also `sudo docker system prune -af` frees root if Docker images piled up. Staging app VM (`136.114.103.71`) is **not** the Actions runner.

## Production hosts

- App/proxy VM (`ubuntu-intelbroadwell`, Linode): `130.245.136.44`, 8 vCPU, 16 GB RAM
- Database VM (`ubuntu-intelbroadwell-001`, Linode): `130.245.136.21`, 8 vCPU, 16 GB RAM

## Notes for deploy/ops guidance

- Capacity comparisons should use staging app VM (8 vCPU) vs production app VM (8 vCPU).
- Staging default shape is dual-worker (`CHATAPP_INSTANCES=2`); for production worker-scaling experiments, temporarily match the intended prod worker count.
- Production app VM: Node HTTP workers may run as **four** processes (`chatapp@4000`–`4003`) when `CHATAPP_INSTANCES=4` / `CHATAPP_INSTANCES_PROD=4`; nginx `upstream app` lists all active ports.
- If infra changes, update this file and mention the date in the "Last updated" line.
