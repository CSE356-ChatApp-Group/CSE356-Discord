# Infrastructure Inventory

Last updated: 2026-04-14

This is the source of truth for current environment shape. Update this file whenever VM sizing, hosts, or provider layout changes.

## Staging / CI hosts

- Staging app VM (`staging-vm`, GCP Compute Engine): `e2-standard-8` (8 vCPU, 32 GB RAM)
- GitHub Actions runner VM #1 (`github-actions-runner`, GCP Compute Engine): `c3-standard-4` (4 vCPU, 16 GB RAM)
- GitHub Actions runner VM #2 (GCP Compute Engine): `e2-standard-4` (4 vCPU, 16 GB RAM)

## Production hosts

- App/proxy VM (`ubuntu-intelbroadwell`, Linode): `130.245.136.44`, 8 vCPU, 16 GB RAM
- Database VM (`ubuntu-intelbroadwell-001`, Linode): `130.245.136.21`, 8 vCPU, 16 GB RAM

## Notes for deploy/ops guidance

- Capacity comparisons should use staging app VM (8 vCPU) vs production app VM (8 vCPU).
- Keep staging dual-worker shape (`CHATAPP_INSTANCES=2`) when validating production-facing capacity changes.
- If infra changes, update this file and mention the date in the "Last updated" line.
