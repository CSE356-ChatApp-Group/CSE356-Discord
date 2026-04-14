# Ansible

This directory drives **inventory** and optional **playbooks** around the existing shell deploy tooling in `deploy/`. Behavior matches `./deploy/deploy-staging.sh` and `./deploy/deploy-prod.sh`; Ansible supplies host/user defaults from `inventory/hosts.yml` (aligned with `docs/infrastructure-inventory.md`).

## Prerequisites

- [Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html) 2.14+ on the machine that runs playbooks (your laptop or CI).
- SSH keys for `ansible_user` on each host (same as manual deploys).
- Repository checkout at any path — playbooks resolve `deploy/*.sh` relative to this `ansible/` tree.

## Parity with GitHub Actions deploys

CI still runs **`deploy/deploy-staging.sh`** / **`deploy/deploy-prod.sh`** directly ([`reusable-vm-deploy.yml`](../.github/workflows/reusable-vm-deploy.yml)); these playbooks are **wrappers** with the same environment variables. Keep **`ansible/inventory/hosts.yml`** aligned with repo variables **`STAGING_HOST`**, **`STAGING_USER`**, **`PROD_HOST`**, **`PROD_USER`** (or workflow defaults) so manual Ansible runs target the same hosts as Actions.

**Releases:** `deploy-staging.sh` downloads from **`GITHUB_REPO`** (default in script). If your fork is not the default org/repo, set `github_repo` in `group_vars/all.yml` or pass `-e github_repo=owner/repo` when running deploy playbooks.

**CI:** `ci-deploy.yml` runs `ansible-playbook --syntax-check` on all playbooks in the **`deploy-scripts`** job (installs **`ansible-core`** via **`apt-get`** on the self-hosted runner if `ansible-playbook` is missing).

## Inventory

Edit `inventory/hosts.yml` when staging or production IPs or SSH users change. Optional overrides live in `group_vars/`.

## Common commands

Run all commands from the **`ansible/`** directory (so `ansible.cfg` applies), or pass `-i` / `ANSIBLE_CONFIG` explicitly.

```bash
cd ansible

# Connectivity (staging only if prod SSH is blocked from your network)
ansible-playbook playbooks/ping.yml --limit staging

# All inventory hosts
ansible-playbook playbooks/ping.yml

# One-time VM setup (runs deploy/staging-vm-setup.sh or deploy/prod-vm-setup.sh on the host)
ansible-playbook playbooks/bootstrap-staging.yml
ansible-playbook playbooks/bootstrap-prod.yml

# Deploy CI-built release by SHA (same as running deploy-staging.sh / deploy-prod.sh by hand)
ansible-playbook playbooks/deploy-staging.yml -e deploy_sha=abc1234
ansible-playbook playbooks/deploy-prod.yml -e deploy_sha=abc1234
```

`deploy-prod.sh` may still prompt for confirmation unless you adapt the script for non-interactive runs.

### Extra environment (artifact path, tuning)

The underlying scripts honor the same variables as documented in `deploy/README.md` (for example `LOCAL_ARTIFACT_PATH`, `GITHUB_REPO`, `CHATAPP_INSTANCES`). Export them in the shell before `ansible-playbook`, or extend the playbooks with `environment:` entries.

## GitHub Actions

Existing workflows continue to call `deploy/deploy-*.sh` directly. To use Ansible in CI, add a step that installs Ansible and runs the matching playbook with `-e deploy_sha=${{ github.sha }}`, ensuring `DEPLOY_SSH_KEY` (or agent) can reach the inventory hosts.
