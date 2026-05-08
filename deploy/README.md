# Deployment Guide

**Documentation hub (canonical env, topology, update rules):** [docs/README.md](../docs/README.md)

This document describes the deployment pipeline for ChatApp:

- **Dev**: Local + CI containers
- **Staging**: Google Cloud Compute Engine VM (temporarily unavailable)
- **Production**: multi-VM Linode cluster (nginx + workers on **VM1** `ubuntu@130.245.136.44`, plus VM2/VM3 app hosts, DB, monitoring — see [docs/infrastructure-inventory.md](../docs/infrastructure-inventory.md)).

## Temporary no-staging mode

Staging is temporarily disabled as a required gate because the GCP staging host is unavailable / credits constrained.

Current release policy:

- CI/typecheck/tests + package-release must pass before production deploy.
- Production deploy is manual only (no auto-deploy from `main`).
- App-worker behavior changes use VM3-first canary, then 5-15 minute gate, then full rollout.
- Singleton/lease behavior changes require validating lease ownership by the patched build; if VM3 cannot own the lease, use a short controlled fleet rollout with rollback ready.
- DB/global config changes are maintenance-style changes with explicit rollback; VM canary does not replace this.
- Do not run overlapping behavior canaries.

> Public entry points (IPs drift with inventory; verify there):
> - Staging app: `http://136.114.103.71`
> - Production (VM1 / default nginx): `http://130.245.136.44` — course Grafana may use HTTPS on a hostname (e.g. README “Remote browser access”); not every path is TLS on the raw IP.

**Environment variables:** see [docs/env.md](../docs/env.md) for every API tunable and a **production shared `.env` audit** checklist (`/opt/chatapp/shared/.env` on the host).

**Infrastructure inventory:** see [docs/infrastructure-inventory.md](../docs/infrastructure-inventory.md) for current VM shapes (staging, prod, runners).

**Prod deploy shell layout:** default prod IPs live in [`deploy/inventory-defaults.sh`](./inventory-defaults.sh) (override with env; keep aligned with the inventory doc). Remote pool sizing and Node heap tuning (SSH reads + derived env) live in [`deploy/deploy-prod-remote-sizing.sh`](./deploy-prod-remote-sizing.sh), sourced early from [`deploy/deploy-prod.sh`](./deploy-prod.sh). Rolling nginx upstream edits, health gates, worker restart, and `rollback_cutover` live in [`deploy/deploy-prod-rolling.sh`](./deploy-prod-rolling.sh). Idempotent nginx Python patch steps live in [`deploy/deploy-prod-nginx-patches.sh`](./deploy-prod-nginx-patches.sh). The background Prometheus/Grafana/monitoring-VM + app-VM exporter refresh lives in [`deploy/deploy-prod-monitoring-sync.sh`](./deploy-prod-monitoring-sync.sh). `deploy-prod.sh` wires phases and sources those modules. Multi-VM orchestration is [`deploy/deploy-prod-multi.sh`](./deploy-prod-multi.sh).

## Architecture Overview

```
┌─────────────────┐
│  GitHub / Main  │
└────────┬────────┘
         │
         ▼ (on push)
┌──────────────────────┐
│ CI: Build & Package  │  ← Builds once, artifacts locked
│  (GitHub Actions)    │
└─────────┬────────────┘
          │
          ├─────────────────────────────────┐
          │                                 │
          ▼                                 ▼
    ┌──────────────┐               ┌──────────────┐
    │  Staging VM  │               │ Production   │
    │ (Google      │   (Manual)    │ multi-VM     │
    │  Cloud)      │ ──approval──► │ (VM1–3+DB)   │
    │              │               │              │
    │ Verify       │               │ Validate +   │
    │ behavior +   │               │ cutover      │
    │ integration  │               │              │
    └──────────────┘               └──────────────┘
```

## CI Pipeline

### Trigger
Pushes and pull requests targeting `main` run **deploy-scripts**, **backend**, and **frontend** jobs. **Packaging** and **GitHub Releases** run only on pushes to `main` (`package-release` in `ci-deploy.yml`). Staging auto-deploy is temporarily disabled and does not gate CI completion.

**Staging Playwright on `main` pushes:** currently disabled alongside staging auto-deploy. Nightly/manual coverage remains available in **Staging E2E** (`.github/workflows/staging-e2e-nightly.yml`) for when staging access is restored.

### Steps (see `.github/workflows/ci-deploy.yml`)
1. **deploy-scripts:** `bash -n` / `shellcheck` on deploy scripts, `promtool check rules` on `infrastructure/monitoring/alerts.yml`, Grafana dashboard JSON validation, Ansible syntax-check on `ansible/playbooks/*.yml`, plus small `node --check` / `py_compile` gates.
2. **backend** job: `npm ci`, `npm run typecheck --workspace=backend`, `npm run test --workspace=backend`, `npm run build --workspace=backend`.
3. **frontend** job: `npm ci`, `npm run typecheck --workspace=frontend`, `npm run test --workspace=frontend`, `npm run build --workspace=frontend`.
4. **package-release** (only `push` to `main`, not PRs): after downloading `backend/dist` and `frontend/dist` artifacts, CI runs **`scripts/release/verify-backend-dist-release-sha.sh`** (must match `github.sha`), then builds `releases/chatapp-<sha>.tar.gz` with `backend/dist/` (including **`.build-sha`** written at compile time), `backend/scripts/run-migrations.cjs`, `backend/package*.json`, `backend/tsconfig.json`, `frontend/dist/`, `frontend/package*.json`, `migrations/`, root `package*.json`, `.env.example`, `deploy/env/prod.required.env`, `deploy/env/staging.required.env`, `deploy/apply-env-profile.py`.
5. Upload workflow artifact `release-<sha>` and create/update GitHub Release tag **`release-<sha>`** with that tarball.

### Artifact
Each release is immutable and tagged by commit SHA. The **same artifact** is deployed to production (and to staging again once restored). **`backend/dist/.build-sha`** records the **git commit that produced `backend/dist`**; packaging fails if that file is missing or does not match the tarball’s release SHA (prevents **`SKIP_BUILD=1`** from silently shipping stale compiled output).

## Deploy without GitHub (recommended for canaries)

GitHub’s unauthenticated API is easy to rate-limit; **`gh release download`** can fail mid-rollout.

**Preferred:** build the same tarball CI produces, then point `deploy-prod.sh` at it (no `gh` on the release step; preflight skips `gh` when this is set):

```bash
./scripts/release/package-release-artifact.sh
SHA=$(git rev-parse HEAD)
export LOCAL_ARTIFACT_PATH="$PWD/releases/chatapp-${SHA}.tar.gz"

# VM3-only canary
DEPLOY_STOP_AFTER_VM3=1 ./deploy/deploy-prod-multi.sh "$SHA"

# Full multi-VM rollout
./deploy/deploy-prod-multi.sh "$SHA"
```

**Never point `LOCAL_ARTIFACT_PATH` at a stale `releases/chatapp-*.tar.gz` for a different commit.** The deploy scripts **fail closed** before `scp`: they read **`backend/dist/.build-sha`** from the tarball and require it to match the requested deploy SHA (resolved with `git rev-parse` when run from this repo). A tarball whose **filename** matches `<sha>` but whose embedded dist was built from another commit (for example after **`SKIP_BUILD=1`** without a matching rebuild) is rejected. Prefer the **GitHub `release-<sha>`** asset (`gh release download …`) or a tarball you just produced with **`package-release-artifact.sh`** for that SHA.

Optional: **`SKIP_BUILD=1`** only when **`backend/dist/.build-sha`** already equals the release SHA you are packaging (for example you just ran **`npm run build --workspace=backend`** on that same commit). Otherwise run **`./scripts/release/package-release-artifact.sh`** with a normal build (default) or use the **CI** `release-<sha>` artifact. If verification fails, **rebuild without `SKIP_BUILD=1`** so `tsc` and **`write-dist-build-metadata.cjs`** refresh `dist/` and `.build-sha`.

**Also useful:** keep last *N* tarballs on VM1 (or object storage) and `scp` between hosts (**option 2**). **`GITHUB_TOKEN`** / `gh auth login` still helps CI and ad-hoc `gh` use (**option 3**). **`deploy-prod.sh`** retries `gh release download` up to **five times** with **30s** backoff before failing.

**Integrity:** `deploy-prod.sh` and `deploy-staging.sh` compute **SHA-256** (`openssl dgst`) of the tarball **before** `scp` and **re-check on the remote** immediately before `tar` extract, so a partial copy fails fast. `package-release-artifact.sh` also writes **`releases/chatapp-<sha>.tar.gz.sha256`** for manual `shasum -a 256 -c` / `sha256sum -c` checks. **Build SHA:** before any remote copy, both scripts run **`chatapp_verify_release_tarball_build_sha`** (see **`deploy/lib/deploy-guards.sh`**) so the bytes inside the tarball match the requested git release.

## GitHub Button Deploys

Staging auto-deploy from `ci-deploy.yml` is temporarily disabled while staging is unavailable.

You can still deploy manually from GitHub Actions using **Manual Deploy** (`workflow_dispatch`) in `.github/workflows/deploy-manual.yml`. For **prod**, optional flags include **VM3 canary only** (deploy the chosen SHA through VM3, then stop so you can soak before a second run without the flag for the full rollout) and **clear deploy lock** if a prior run stuck the lock on the VMs.

**Production fast rollback (GitHub):** use **Production fast rollback** (`.github/workflows/rollback-prod-fast.yml`). It resolves your `sha`, skips waiting for a GitHub Release tarball, and runs `deploy-prod-multi.sh <sha> --rollback` so workers move back to a build **already present** under `/opt/chatapp/releases/<sha>` on each VM. Use **Manual Deploy** instead if you need a full redeploy from a release artifact (migrations, new tarball, etc.).

### Required GitHub configuration

- Secret: `DEPLOY_SSH_KEY` — private key whose public half is in `authorized_keys` on the deploy VMs (Ed25519 matches [`reusable-vm-deploy.yml`](../.github/workflows/reusable-vm-deploy.yml), which writes `~/.ssh/id_ed25519`).
- Optional secret: `SSH_KNOWN_HOSTS` — one or more `ssh-keyscan -H` lines. **Recommended for production** when the app host and DB host differ: [`deploy-prod.sh`](deploy-prod.sh) SCPs to `PROD_HOST` and `PROD_DB_HOST`, but the workflow only auto-keyscans the primary `host` input, so pin both (or rely on `DEPLOY_SSH_EXTRA_OPTS` / host-key policy only on the runner side after keys rotate).
- Repository/environment variables (optional overrides):
   - `STAGING_HOST` (default: `136.114.103.71`)
   - `STAGING_USER` (default: `ssperrottet`)
   - `PROD_HOST` (default: `130.245.136.44`)
   - `PROD_USER` (default: `ubuntu`)
   - `DEPLOY_RUNS_ON_STAGING` (default: `["ubuntu-latest"]`)
   - `DEPLOY_RUNS_ON_PROD` (default: `["ubuntu-latest"]`)
   - If you move production to a new VM/IP, update `PROD_HOST` in GitHub environment variables before running deploys.
- GitHub Environment protection:
   - Set approvals on `production` environment to require manual reviewer approval.

#### Self-hosted deploy runners (recommended, no new VMs required)

If GitHub-hosted runners cannot reliably SSH to your VMs, keep build/test on `ubuntu-latest` and move only deploy jobs to self-hosted labels.

- **Staging deploy runner:** existing staging app VM (`136.114.103.71`) with label `deploy-staging`.
- **Prod deploy runner:** existing monitoring VM (`130.245.136.120`) with label `deploy-prod` (keeps deploy orchestration load off VM1 during rollouts).
- Set repository variables:
  - `DEPLOY_RUNS_ON_STAGING` = `["self-hosted","deploy-staging"]`
  - `DEPLOY_RUNS_ON_PROD` = `["self-hosted","deploy-prod"]`

Workflows default to `["ubuntu-latest"]` when these variables are unset, so cutover is reversible without code changes.

#### Set secrets with `gh` (from a maintainer laptop)

Log in (`gh auth login`) with permission to manage secrets. Environments **`staging`** and **`production`** must exist under **Settings → Environments** if you store environment-scoped secrets (recommended).

One-shot helper (scans host keys, then uploads):

```bash
./scripts/ops/gh-set-deploy-ssh-secrets.sh --key ~/.ssh/your-deploy-key.ed25519 \
  --scan-hosts "136.114.103.71" --env staging

./scripts/ops/gh-set-deploy-ssh-secrets.sh --key ~/.ssh/your-deploy-key.ed25519 \
  --scan-hosts "130.245.136.44,130.245.136.21" --env production
```

Use `--env repo` for repository-level secrets only, or `--env all` to push the same key and known_hosts to both environments. `--dry-run` prints the `gh` invocations without calling GitHub or `ssh-keyscan`.

**Prod DB SSH from Actions:** `deploy-prod-multi.sh` Phase -1 SSHs to `PROD_DB_HOST` (default in inventory). GitHub-hosted runners occasionally see `kex_exchange_identification: Connection closed by remote host` when `sshd` is briefly overloaded or rate-limited; the workflow and script retry with backoff. Override with `DB_SSH_PREFLIGHT_ATTEMPTS` / `DB_SSH_PREFLIGHT_INITIAL_SLEEP`, or set `SKIP_DB_SSH_PREFLIGHT=1` only for emergencies.

Equivalent manual commands:

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh secret set DEPLOY_SSH_KEY --repo "$REPO" --env production < ~/.ssh/your-deploy-key.ed25519
( ssh-keyscan -H 130.245.136.44; ssh-keyscan -H 130.245.136.21 ) | gh secret set SSH_KNOWN_HOSTS --repo "$REPO" --env production

gh variable set PROD_HOST --body "130.245.136.44" --repo "$REPO"
gh variable set PROD_USER --body "ubuntu" --repo "$REPO"
```

### How to run

1. Open GitHub Actions → **Manual Deploy**.
2. Click **Run workflow**.
3. Choose `environment`: `prod` (use `staging` only if/when staging access is restored).
4. Optionally provide `sha` (if empty, workflow uses selected ref SHA). Short SHAs and refs are resolved to the full commit before checkout/download.

Actions run **`ansible/playbooks/deploy-staging.yml`** / **`deploy-prod.yml`** ([`reusable-vm-deploy.yml`](../.github/workflows/reusable-vm-deploy.yml)), which call the same **`deploy/deploy-*.sh`** scripts as a local console deploy — one canonical path.

**Ansible:** inventory for **manual** runs, bootstrap playbooks, and docs are in [`ansible/README.md`](../ansible/README.md).

## Staging Deployment (currently unavailable)

Staging is currently unreachable and should not block production deployment decisions.
Keep this section for restoration work; production rollout decisions currently rely on CI + production canary policy.

## Staging Deployment (reference when restored)

### Prerequisites
- Staging VM on Google Cloud Compute Engine (Ubuntu 22.04 LTS)
- Staging database (Postgres)
- Staging Redis cache
- GitHub CLI (`gh`) installed locally for artifact download

### Setup (one-time)

1. Create Compute Engine VM:
   ```bash
   gcloud compute instances create chatapp-staging \
     --machine-type=e2-medium \
     --zone=us-central1-b \
     --image-family=ubuntu-2204-lts \
     --image-project=ubuntu-os-cloud
   ```

2. SSH into VM and run setup:
   ```bash
   gcloud compute ssh chatapp-staging
   # Then run staging-vm-setup.sh
   ```

3. Create staging database and Redis:
   ```bash
   # Use Google Cloud SQL for Postgres
   # Use Google Cloud Memorystore for Redis
   # Note connection strings in /opt/chatapp/shared/.env
   ```

### Deploy to Staging

```bash
STAGING_HOST=136.114.103.71 GITHUB_REPO=CSE356-ChatApp-Group/CSE356-Discord ./deploy/deploy-staging.sh <commit-sha>
```

This:
1. Downloads the prebuilt artifact from GitHub Releases
2. Copies to staging VM
3. Unpacks and installs dependencies
4. Starts on candidate port (4001)
5. Runs health checks + smoke tests
6. If healthy, switches Nginx to new version
7. Monitors for 30 seconds
8. Reports success or failure

### Verify Staging

```bash
# SSH to staging
gcloud compute ssh chatapp-staging

# Check current release
source /opt/chatapp/shared/deploy-utils.sh
current_release
list_releases

# Check health
curl http://136.114.103.71/health

# Tail logs (systemd template is `chatapp@PORT`, usually 4000 + 4001)
sudo journalctl -u 'chatapp@*' -f
```

### Rollback Staging

If issues are discovered:

```bash
# Manual rollback via Nginx
ssh <staging-user>@136.114.103.71 "
  sudo sed -i 's/localhost:4001/localhost:4000/' /etc/nginx/sites-available/chatapp
  sudo systemctl reload nginx
"
```

## Production Deployment

### Prerequisites
- Production VM reachable at `ubuntu@130.245.136.44`
- Production database (Postgres)
- Production Redis cache
- Nginx configured for blue-green or candidate-port deployment
- SSH access as `ubuntu` user (or configured user)

### Release Directory Structure

Production uses immutable release directories:

```
/opt/chatapp/
├── releases/
│   ├── 2026-03-27T141500-a1b2c3d/     ← Old release
│   │   ├── backend/dist/
│   │   ├── backend/package*.json
│   │   ├── frontend/dist/
│   │   └── migrations/
│   │
│   └── 2026-03-27T153200-d4e5f6g/     ← New release
│       └── ...
│
├── current -> releases/2026-03-27T153200-d4e5f6g  ← Symlink to active
│
├── shared/
│   ├── .env                           ← Shared secrets
│   ├── logs/
│   └── backups/
```

### Deploy to Production

Shared nginx-related strings and the default site path live in `deploy/deploy-common.sh`; `deploy-prod.sh` and `preflight-check.sh` source it so retries and heal logic stay aligned.

**Warning: This deploys to production. Ensure CI is green and use the VM3 canary gate before full rollout.**

#### Zero-downtime production rollout (plan)

Production deploys are designed for **no hard cut** while old and new binaries briefly overlap:

1. **Ship code** — merge to `main`, wait for **CI Build & Package** + **`release-<sha>`** on GitHub Releases (same artifact staging and prod use).
2. **Run canary gate** — deploy VM3 first (`DEPLOY_STOP_AFTER_VM3=1` or `canary-promote.yml`), watch 5-15 minutes, then promote only if gate is green.
3. **Preflight prod** — `./deploy/preflight-check.sh prod <sha> <PROD_USER> <PROD_HOST> <GITHUB_REPO>` from a host that can SSH and reach the artifact (VPN/firewall as needed).
4. **Run prod deploy** — `CHATAPP_INSTANCES=4 ./deploy/deploy-prod.sh <sha>` (or **Manual Deploy** → `production` in GitHub Actions). The script: **pg_dump backup** → candidate on a **spare non-live port** when prod already has 3+ live workers (or the legacy alternate port in 1–2 worker layouts) → health + smoke **before** nginx sends live traffic → **pin candidate → roll non-candidate workers → restore upstream** so users keep an upstream during the swap.
5. **Migrations** — keep changes **backward compatible** across the window where both versions may answer (see step 9 narrative below). Destructive DDL only with a separate maintenance plan.
6. **After cutover** — `./scripts/ops/prod-nginx-audit.sh`, watch Grafana/Prometheus, keep old release on disk for rollback. For a single local bundle (backend tests + staging API contract + deploy script sanity + optional grader gate): `npm run verify:release` (set `SKIP_GRADER_WATCH_GATE=1` if you are not in an active soak window, or truncate stale `artifacts/rollout-monitoring/grader-watch-events.jsonl` before gating).
7. **Rollback** — re-run `deploy-prod.sh` with the **previous SHA**, or use the script’s rollback path / nginx upstream fix (see **Immediate Rollback** below); do not blind-`sed` nginx ports.

**Not touched by this process:** DNS (same VM), Postgres availability (brief pool pressure only if migrations are heavy). **Downtime risk** is usually mis-nginx or bad migration, not the Node swap itself.

```bash
# Production defaults to four workers (CHATAPP_INSTANCES=4). Override only if you intentionally
# run fewer workers on a smaller host:
CHATAPP_INSTANCES=4 ./deploy/deploy-prod.sh <commit-sha>
```

`deploy-prod.sh` rewrites the whole `upstream app { ... }` block (no fragile global `sed` on ports). When **`CHATAPP_INSTANCES>=3`**, the candidate starts on a **spare port outside the live upstream** so nginx never targets a worker that is being restarted. After **9c** restores `least_conn`, **9c.1** stops that spare `chatapp@` unit when it is **not** in the live port set so parity gates (and nginx) never see an extra active worker. The final verification also checks **systemd `release.conf` drop-ins**, **`/opt/chatapp/current`**, and a short **`curl` burst on `http://127.0.0.1/health`** through nginx (**`INGRESS_POST_DEPLOY_SECONDS`**, default **20**). In 1–2 worker layouts, the script still uses the legacy alternate-port flip. When **`CHATAPP_INSTANCES>=2`**, step **9** only applies **listen backlog / `nginx.conf` / sysctl** tuning and leaves current upstreams in place while the candidate warms up. Step **9a** pins nginx to the **candidate port only** before **9b** restarts non-candidate workers (**`PIN_CANDIDATE_BEFORE_COMPANION`** defaults **`true`** so POST traffic is not routed to a restarting peer; set `false` only if you accept brief 502s or rely on **`proxy_next_upstream … non_idempotent`** in `/api/`). **9c** restores `least_conn` across all target worker ports (`4000..4000+CHATAPP_INSTANCES-1`) with **`max_fails=0`** so transient 5xx bursts do not drain every peer and trigger `no live upstreams`. There is still a **shared-traffic window** before **9a** where **old and new code** may both serve requests; keep DB migrations and API responses **backward compatible** across that window. After **9a**, capacity is on the candidate only until **9c** completes.

**GitHub Actions:** manual prod deploy passes `chatapp_instances` (default **4** via `CHATAPP_INSTANCES_PROD` repo variable or literal `4` in `deploy-manual.yml`). Set repo variable `CHATAPP_INSTANCES_PROD` lower only if you intentionally run a smaller worker pool.

#### Deploy reliability gates (lock release + worker drift + fleet parity)

`deploy-prod.sh` and `deploy-prod-multi.sh` enforce three guards that exist to catch real bugs we hit in production rollouts:

1. **Remote deploy-lock release on EVERY exit path.** `acquire_remote_deploy_lock` writes `/opt/chatapp/.deploy-lock-prod/{owner,release_sha,started_at,started_at_iso}` on the target VM under `PROD_HOST`; the matching `cleanup_on_exit` is registered with `trap cleanup_on_exit EXIT INT TERM HUP` immediately after the lock is acquired so a CI cancel, Ctrl-C, or `SIGTERM` still SSHes back in to `rm -rf` the lock dir. Past regression: a later `_combined_cleanup` trap silently *replaced* `cleanup_on_exit`, so the lock was never released on success and every subsequent deploy hit `ERROR: prod deploy lock is held` (exit 42). The static guard in `scripts/deploy/test-deploy-guards.sh` blocks any reintroduction.
2. **CHATAPP_INSTANCES drift refuses to start the deploy.** Before computing `TARGET_PORTS`, the script lists the host's active `chatapp@*.service` units. If the count exceeds `CHATAPP_INSTANCES` from `/opt/chatapp/shared/.env`, the deploy aborts with the offending ports and remediation. Past regression: WSVM1 ran 6 active workers while shared `.env` recorded `CHATAPP_INSTANCES=5`; rolling restart only covered :4000–:4004, leaving `chatapp@4005` on a stale `release.conf` drop-in. The next manual `systemctl restart chatapp@4005` would then load whatever release path the orphaned drop-in pointed at.
3. **Fleet release parity gate after Phase 7.** `deploy-prod-multi.sh` SSHes every targeted VM (VM1/2/3 + WSVM1/2/3 when `WS_TIER_ENABLED=true`), enumerates active `chatapp@*` units, and compares `/proc/<pid>/cwd` plus the systemd drop-in `WorkingDirectory` against `/opt/chatapp/releases/<deploy-sha>/backend`. On mismatch it prints per-port `DRIFT  :<port>  pid=<pid>  cwd=<actual>  drop=<dropin>` lines and fails the deploy. Skipped only under `--rollback` and `--emergency`.

##### Manual validation (no deploy required)

Run the static regression test locally to verify these guards still fire (this is the same script CI executes via `bash scripts/deploy/test-deploy-guards.sh`):

```bash
npm run test:deploy-guards
```

To check the live fleet without running a deploy, you can mirror what the parity gate does:

```bash
SHA=<release-sha>
EXPECTED="/opt/chatapp/releases/${SHA}/backend"
for spec in "ubuntu@130.245.136.44 4000-4003 vm1" \
            "ubuntu@130.245.136.137 4000-4005 vm2" \
            "ubuntu@130.245.136.54 4000-4005 vm3" \
            "root@130.245.136.218 4000-4005 wsvm1" \
            "root@130.245.136.172 4000-4005 wsvm2" \
            "root@130.245.136.46 4000-4005 wsvm3"; do
  set -- $spec
  user_host=$1; range=$2; label=$3
  echo "--- ${label} (${user_host}) ---"
  ssh -o BatchMode=yes "${user_host}" "for p in \$(seq ${range/-/ }); do
    if ! systemctl is-active --quiet chatapp@\${p} 2>/dev/null; then continue; fi
    pid=\$(systemctl show -p MainPID --value chatapp@\${p})
    cwd=\$(readlink -f /proc/\${pid}/cwd 2>/dev/null || echo unknown)
    [ \"\$cwd\" = \"${EXPECTED}\" ] && echo \"OK    :\${p}\" || echo \"DRIFT :\${p} cwd=\${cwd}\"
  done"
done
```

The expected output after a successful deploy is `OK :<port>` for every active worker on every VM (34 lines under the standard topology). Any `DRIFT` line means that worker is serving a previous release.

**Three-app-VM production** (`./deploy/deploy-prod-multi.sh <sha>`): deploys VM3 → VM2 → VM1 with per-VM PgBouncer. For a **VM3-only canary** (pause before VM2/VM1), run `PROD_USER=ubuntu DEPLOY_STOP_AFTER_VM3=1 ./deploy/deploy-prod-multi.sh <sha>`; see [`docs/history/canary-read-receipt-insert-lock-shedding.md`](../docs/history/canary-read-receipt-insert-lock-shedding.md). **`redis_exporter`** is installed over SSH to **`REDIS_EXPORTER_SSH_HOST`** (default VM1 public IP); Prometheus scrapes **`PROM_REDIS_HOST:9121`** (default VM1 private IP). Override if you move the exporter.

This:
1. Confirms you want to deploy to production (interactive prompt)
2. Backs up production database
3. Downloads the artifact from GitHub Releases
4. Copies to production server
5. Unpacks candidate release
6. Starts on alternate port (4001) **without touching running traffic**
7. Runs health checks + smoke tests against candidate
8. **Only if healthy**, updates Nginx: **single-worker** → traffic to candidate only; **multi-worker** → tune only with existing upstreams, pin to candidate (**9a**), roll non-candidate workers (**9b/9b.5**), restore full upstream (**9c**)
9. Monitors for 60 seconds
10. Updates `current` symlink
11. Keeps old version running on original port for instant rollback

### Production nginx audit (multi-upstream)

After any hand-edited nginx config or if you see `no live upstreams` in `error.log`:

```bash
./scripts/ops/prod-nginx-audit.sh
```

This fails if active `chatapp@` workers are missing from `upstream app` (for example `4000/4001` in dual-worker mode, or `4000..4003` in 4-worker mode).

**Abusive client IP (nginx `deny`)** — after confirming the address is not a grader or shared NAT, run on the VM (or copy `deploy/nginx/patches/patch-nginx-deny-ip.sh` and execute with sudo):

```bash
sudo CHATAPP_NGINX_SITE_PATH=/etc/nginx/sites-available/chatapp ./deploy/nginx/patches/patch-nginx-deny-ip.sh 203.0.113.10
```

Idempotent: safe to re-run. Prefer updating `deploy/nginx/staging.conf` / prod bootstrap templates in-repo too so the next full nginx rewrite keeps the rule. **Staging** installs [`deploy/nginx/admission-control.conf`](./nginx/admission-control.conf) (`http_ip_strict` / `http_slash24` zones). **Production** installs [`deploy/nginx/admission-control-production.conf`](./nginx/admission-control-production.conf) (`external_*` zones used by the prod `chatapp` site). Internal RFC1918 clients get an empty limit key, so those nginx edge limits do not apply to grader-style 10.x traffic (see comments in the production file).

### App VM disk hygiene (journal, apt cache, nginx logrotate)

Under heavy traffic, nginx access logs can grow faster than **daily** rotation allows. `deploy/prod-disk-hygiene.sh` is **idempotent**: it adds `maxsize 200M` to `/etc/logrotate.d/nginx` when missing, vacuums the systemd journal (`JOURNAL_VACUUM_SIZE`, default **800M**), runs `apt-get clean`, then best-effort `logrotate -f` for nginx.

On the prod app host (from a repo checkout, or after copying the script):

```bash
sudo DRY_RUN=1 ./deploy/prod-disk-hygiene.sh
sudo ./deploy/prod-disk-hygiene.sh
# Skip the final `logrotate -f` if SSH must return quickly (maxsize still applies on cron):
sudo SKIP_FORCE_NGINX_LOGROTATE=1 ./deploy/prod-disk-hygiene.sh
```

New installs run the same nginx `maxsize` guard from `deploy/prod-vm-setup.sh` (step 5b).

### Read-only production capacity snapshot

From a machine with SSH to the prod **app** and **DB** hosts (override `PROD_HOST`, `PROD_DB_HOST`, `PROD_USER`, `PROD_POSTGRES_DB` if needed):

```bash
./deploy/analyze-prod-capacity.sh
```

The script prints `df`, nginx logrotate hints, PgBouncer `SHOW POOLS`, a short scrape of each worker’s `/metrics` (pool gauges, overload counters, `message_post` 201 vs 503), and Postgres `pg_stat_activity` counts. In Grafana, watch **pg pool waiting**, **circuit breaker rejects**, and **message_post** status codes when validating overload behavior.

### Capacity gate before tuning prod

Run load on **staging** first when available (same `CHATAPP_INSTANCES` shape as prod when possible):

```bash
# Steady SLO probe (~8m) — see optimization_* thresholds in staging-capacity.js
./scripts/load/run-staging-capacity.sh slo

# Stress envelope (expect threshold breaches; read optimization_* and failure mix)
./scripts/load/run-staging-capacity.sh break
```

Promote pool / `FANOUT_QUEUE_CONCURRENCY` / `OVERLOAD_*` changes to prod only after staging artifacts look acceptable.

### Scaling up (8 vCPU) or moving Postgres off-box

**Vertical scale (recommended first step)**  
1. Resize the production VM to **8 vCPU** (and **≥16 GiB RAM** if the platform allows — you still run **PostgreSQL + PgBouncer + four Node workers on the current prod layout + nginx + Redis** on one host).
2. Run a normal prod deploy (`CHATAPP_INSTANCES=4` on the current host layout unless you are intentionally scaling down). [`deploy-prod.sh`](./deploy-prod.sh) probes **`nproc`** and **`MemTotal`** on the VM and recomputes **PgBouncer `default_pool_size`**, **`PG_POOL_MAX` per instance**, **`max_connections`**, **`FANOUT_QUEUE_CONCURRENCY`**, **`BCRYPT_MAX_CONCURRENT`**, heap caps, etc. You do **not** hand-edit pool sizes for a larger SKU unless you are doing something special.
3. If PostgreSQL needs a restart to apply a higher `max_connections`, either set **`ALLOW_DB_RESTART=true`** for that one deploy (see script header / postgres tuning block) or restart Postgres once after deploy when maintenance allows.

**Why this matters:** older sizing used a term that **capped** the PgBouncer pool at **170** for any **two-worker** host with **≥4 vCPU**, so **going from 4→8 vCPU did not increase DB backend headroom**. The current formula scales **`ncpu * 50`** (plus a small multi-worker bump), up to **320** real backends — e.g. **8 vCPU / 2 workers** → **320** pool, **~170** virtual clients per Node cap (see deploy log line at start of run).

**Horizontal DB (managed Postgres)**  
Useful when the **database** is the bottleneck or you want RAM/IO isolated from Node:

- Create a **managed** instance (same region as the app VM if possible).  
- Set **`DATABASE_URL`** in `/opt/chatapp/shared/.env` to the provider connection string. For TLS, append **`?sslmode=require`** (or your provider’s required params) so `node-pg` negotiates SSL.  
- Re-run deploy (or at least the **PgBouncer** step in `deploy-prod.sh`): [`pgbouncer-setup.py`](./pgbouncer-setup.py) builds the `[databases]` stanza from the parsed host/port so PgBouncer on the **app VM** still **pools** to the remote Postgres (transaction mode).  
- **Security groups / firewall**: allow **outbound 5432** (or provider port) from the app VM to the DB; restrict DB ingress to that VM’s IP.  
- Ensure the DB **tier connection limit** is **≥** the deploy-time **`max_connections`** target (upper hundreds after scale-up — check the deploy banner line `pg_max_conn=...`).

**Worker scaling:** `deploy-prod.sh` can now roll and re-add ports **`4000..(4000 + CHATAPP_INSTANCES - 1)`**. Keep `CHATAPP_INSTANCES_PROD` aligned with host CPU and memory headroom, and verify with staging load runs before increasing production worker count.

### Immediate Rollback

If issues are detected after cutover, **`rollback_cutover`** inside `deploy-prod.sh` points nginx at the prior live port (single upstream). For a manual emergency fix, **do not** use a blind `sed` swapping ports (it breaks dual-upstream). Prefer re-running `./deploy/deploy-prod.sh <previous-sha>` or restoring `upstream app` to two healthy `server` lines and `sudo nginx -t && sudo systemctl reload nginx`.

Old process is still running and will resume handling traffic.

### Clean Up Old Releases

After confidence window (~10 minutes):

```bash
ssh ssperrottet@136.114.103.71 "
  # Stop the old process
  pkill -f 'PORT=4000' || true
  
  # Keep releases for rollback, delete very old ones (keep last 5)
  ls -1dt /opt/chatapp/releases/*/ | tail -n +6 | xargs rm -rf
"
```

## Health Checks

### `/health` Endpoint

Returns 200 if:
- Process is running
- Database is reachable
- Redis is reachable

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"2026-03-27T14:15:00.000Z"}
```

Returns 503 if any check fails.

### Pre-Cutover Validation

```bash
./deploy/health-check.sh <port>
```

### Smoke Tests

```bash
./deploy/smoke-test.sh <port>
```

Verifies:
- HTTP health endpoint 200
- API reachable
- Process listening
- Database connected

## Meilisearch Activation

Meilisearch is already wired as an **optional candidate-generation layer** for search. It does **not** replace Postgres authorization or final result recheck. The safe rollout is **write-only warm-up first**, then **read cutover**.

### Preconditions

1. The dedicated host at **`10.0.0.146:7700`** is healthy and reachable from the app VMs.
2. `MEILI_MASTER_KEY` is available in the target host's `/opt/chatapp/shared/.env`.
3. The target release includes the existing backend scripts:
   - `npm --prefix backend run meili:setup-index`
   - `npm --prefix backend run meili:backfill`
   - `npm --prefix backend run meili:health`

### Phase 1: Provision or validate the Meili host

If the dedicated VM is not already configured, bootstrap it once:

```bash
scp deploy/meilisearch-vm-setup.sh ubuntu@10.0.0.146:
ssh ubuntu@10.0.0.146 "MEILI_MASTER_KEY=<secret> bash meilisearch-vm-setup.sh"
```

If it already exists, confirm health from an app host:

```bash
curl -fsS -H "Authorization: Bearer $MEILI_MASTER_KEY" http://10.0.0.146:7700/health
```

### Phase 2: Create the index and warm it before serving reads

From a host with the release checked out and the target env values loaded:

```bash
MEILI_HOST=http://10.0.0.146:7700 \
MEILI_MASTER_KEY=<secret> \
npm --prefix backend run meili:setup-index

MEILI_HOST=http://10.0.0.146:7700 \
MEILI_MASTER_KEY=<secret> \
npm --prefix backend run meili:health
```

Then enable **write-path indexing only** by setting this delta in `/opt/chatapp/shared/.env` on the target app hosts:

```bash
MEILI_ENABLED=true
SEARCH_BACKEND=postgres
```

Deploy that config first. New message create/edit/delete operations will keep the index warm while search traffic still uses Postgres.

Backfill historical rows after write-only mode is live:

```bash
MEILI_HOST=http://10.0.0.146:7700 \
MEILI_MASTER_KEY=<secret> \
DATABASE_URL=<direct-db-url> \
npm --prefix backend run meili:backfill -- --dry-run

MEILI_HOST=http://10.0.0.146:7700 \
MEILI_MASTER_KEY=<secret> \
DATABASE_URL=<direct-db-url> \
npm --prefix backend run meili:backfill
```

### Phase 3: Cut search reads over in staging first

After write-only mode and backfill are healthy, switch the staging app hosts to:

```bash
MEILI_ENABLED=true
SEARCH_BACKEND=meili
```

Redeploy staging and verify:

```bash
MEILI_ENABLED=true SEARCH_BACKEND=meili \
MEILI_HOST=http://10.0.0.146:7700 \
MEILI_MASTER_KEY=<secret> \
npm --prefix backend run meili:health -- --fail-if-disabled

./deploy/smoke-test.sh <port>
```

Expected behavior on the read path:
- Meili provides candidate IDs only.
- Postgres still enforces community / DM access checks.
- Deleted or stale docs are filtered out during Postgres recheck.
- Any Meili timeout or query failure falls back to Postgres search.

### Phase 4: Production rollout

1. Deploy **write-only warm-up** to prod: `MEILI_ENABLED=true`, `SEARCH_BACKEND=postgres`.
2. Confirm `npm --prefix backend run meili:health -- --json` passes on a prod app VM.
3. Watch `meili_index_failures_total`, `meili_search_fallback_total{reason=...}`, and `meili_search_duration_ms` in Grafana/Prometheus. A healthy cutover should not show sustained `strict_token_mismatch`; if it does, rerun `npm --prefix /opt/chatapp/current/backend run meili:setup-index` so the index has the current exact matching settings.
4. Only then switch prod to `SEARCH_BACKEND=meili` and run a normal prod deploy.

### Rollback

Rollback is config-only unless the Meili host itself is causing trouble:

```bash
MEILI_ENABLED=true
SEARCH_BACKEND=postgres
```

This restores the default Postgres search path while preserving warm indexing. If the Meili service itself must be removed from the write path too, also set `MEILI_ENABLED=false` and redeploy.

## OpenSearch POC (No Production Cutover)

OpenSearch integration is scaffolded as a **candidate-retrieval-only POC**. It does not replace Postgres recheck/authorization and is disabled by default.

Run a tiny local single-node instance:

```bash
docker run --rm --name chatapp-opensearch-poc \
  -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "plugins.security.disabled=true" \
  -e "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m" \
  opensearchproject/opensearch:2.15.0
```

POC env flags (keep reads disabled unless explicitly testing):

```bash
SEARCH_BACKEND=meili
OPENSEARCH_URL=http://127.0.0.1:9200
OPENSEARCH_INDEX_MESSAGES=messages_v1
OPENSEARCH_DUAL_WRITE_ENABLED=false
OPENSEARCH_READ_ENABLED=false
OPENSEARCH_MAX_CANDIDATES=250
```

POC scripts:

```bash
tsx scripts/search/backfill-opensearch-messages.ts --dry-run --limit 1000
tsx scripts/search/backfill-opensearch-messages.ts --checkpoint var/opensearch-backfill.checkpoint.json
tsx scripts/search/compare-search-backends.ts --userId <uuid> --communityId <uuid>
```

The backfill always runs against the **primary** PostgreSQL (default `DATABASE_URL`). It refuses
the legacy `--use-read-replica` flag — the cursor pagination needs the non-partial
`(created_at DESC, id DESC)` index added in migration 041, and routing it through the
application read replica saturated `vdb` and pushed replay lag to ~5s on 2026-05-08. To run
against a dedicated heavy-read DSN that is *not* the live replica, set
`OPENSEARCH_BACKFILL_DATABASE_URL` instead. Defaults are conservative (`--batch-size 100`,
`--sleep-ms 250`, session `statement_timeout=30s`, `application_name=opensearch-backfill`).

Do not enable OpenSearch reads in production as part of this POC work.

## Migration Strategy

### Before Deploying

1. **Database migrations only run in compatible direction**:
   - Only additive schema changes
   - No destructive migrations without rollback plan

2. **Review migration**:
   - Run migrations on staging first
   - Verify they work on production data model

3. **Backup database**:
   - `deploy-prod.sh` runs **strict** `pg_dump` before deploy (3 attempts, `pipefail`, `gzip -t` verify). **Deploy fails** if backup fails.
   - When `DATABASE_URL` uses **PgBouncer (`:6432`)**, set **`PGDUMP_DATABASE_URL`** in `/opt/chatapp/shared/.env` to a **direct** `postgresql://…:5432/…` URL (same DB). Dumping through transaction pooling is unreliable. **One-shot helper (app VM):** `scp deploy/ensure-pgdump-env.py user@host:~/ && ssh user@host 'sudo python3 ~/ensure-pgdump-env.py'`
   - **Dedicated volume:** to move Postgres data off root disk, use a maintenance window and [`postgres-migrate-data-volume.sh`](./postgres-migrate-data-volume.sh) on the DB VM (see script header).
   - Keep backups for at least 24 hours

### Post-deploy schema verification

After a deploy that includes **long-running migrations** (for example `009_channel_last_message_denorm.sql`), confirm the database is in a good state before considering the release healthy:

```bash
# From any host with psql and network access to Postgres:
DATABASE_URL='postgres://user:pass@host:5432/dbname' ./deploy/verify-schema.sh
```

The script checks that:

- `009_channel_last_message_denorm.sql` is recorded in `schema_migrations`
- `channels` has `last_message_id`, `last_message_author_id`, and `last_message_at`

**If a previous deploy failed mid-migration**, do not assume re-running `node dist/db/migrate.js` is safe. Inspect `schema_migrations`, the `channels` columns, and Postgres logs; finish or roll back DDL under a maintenance window if needed.

Manual spot checks (optional):

```sql
SELECT filename FROM schema_migrations WHERE filename LIKE '009%';
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'channels'
   AND column_name LIKE 'last_message%';
```

### Capacity: nginx, file descriptors, and swap under load

Grading and load tests open many **HTTP + WebSocket** connections on a small VM. If you see **timeouts, status 0, or upstream failures** before CPU maxes out, check:

1. **Nginx `worker_connections`** (in `/etc/nginx/nginx.conf` inside the `events { }` block). The repo’s [`infrastructure/nginx/nginx.conf`](../infrastructure/nginx/nginx.conf) uses **16384** (aligned with `deploy-prod.sh` / `prod-vm-setup.sh`); default distro configs are often **768** and can bottleneck WebSocket fan-in. **`deploy-prod.sh` rewrites this on deploy**; if you still see `worker_connections are not enough` in `error.log`, raise `NGINX_WORKER_CONNECTIONS` for that run. After manual edits, `sudo nginx -t && sudo systemctl reload nginx`.
2. **Search proxy read timeout**: `location /api/` uses **30s** read timeout; slow-but-successful searches were getting **502** from nginx. **`deploy-prod.sh` step 9.05** inserts `location ^~ /api/v1/search` with **90s** (`proxy_read_timeout` / `proxy_send_timeout`) when missing. Templates in [`deploy/prod-vm-setup.sh`](./prod-vm-setup.sh) and [`deploy/nginx/staging.conf`](./nginx/staging.conf) include the same block.

3. **`LimitNOFILE`** for the Node process: the systemd template [`deploy/chatapp-template.service`](./chatapp-template.service) sets **65535** — ensure production units match.

4. **Swap thrash**: sustained **swap in/out** (not just “some swap used”) hurts latency. If `vmstat` shows high `si`/`so` during tests, add RAM or reduce colocated services; application-level pagination only helps when clients use smaller pages.

5. **Access logs**: keep **JWTs out of nginx access logs** (do not log the `Authorization` header).

6. **Nginx request timing**: each `deploy-staging.sh` / `deploy-prod.sh` run executes [`deploy/nginx/patches/patch-nginx-access-log-timing.sh`](./nginx/patches/patch-nginx-access-log-timing.sh) so `/var/log/nginx/access.log` lines include **`rt=`** (`$request_time`) and **`urt=`** (`$upstream_response_time`) for correlating slow searches with DB or app stalls—without changing the combined-log prefix analyzers rely on.

7. **Postgres checkpoints (dedicated DB VM)**: if logs show multi-minute `checkpoint complete: wrote …` bursts on a short cadence, run [`deploy/tune-postgres-checkpoints.sh`](./tune-postgres-checkpoints.sh) with **`DB_SSH=user@db-host`**. It widens **`checkpoint_timeout`**, raises **`max_wal_size`**, and pins **`checkpoint_completion_target=0.9`**, then **`pg_reload_conf()`** (no restart). Override defaults only when you understand the trade-offs.

### During Deploy

- Old and new versions coexist briefly
- Only switch traffic after new version starts successfully
- If new version crashes during startup → old version untouched

## Observability

### Where application logs go

- The Node process runs under **systemd** units `chatapp@4000` and `chatapp@4001` (see [`deploy/chatapp-template.service`](./chatapp-template.service): `StandardOutput=journal`, `StandardError=journal`, `SyslogIdentifier=chatapp-%i`).
- Logging is **Pino** (`backend/src/utils/logger.ts`). In production, default **`LOG_LEVEL=info`** (overridable in `/opt/chatapp/shared/.env`).
- **HTTP request logging** (`pino-http` in `backend/src/app.ts`): successful, fast requests are logged at **`silent`** in production (so the journal is not flooded). You **will** still see:
  - **`warn`**: HTTP **4xx**, or responses slower than **~1s**
  - **`error`**: HTTP **5xx**, or thrown errors before the response finishes
  - Any `logger.warn` / `logger.error` from the app

So: **yes, you see app-level problems in journald**—mostly as `warning` and `error` priorities, not as noise from every 200 OK.

### Logs (production)

```bash
ssh ubuntu@130.245.136.44

# Live tail (both workers)
sudo journalctl -u 'chatapp@*' -f

# Recent warnings + errors only (good default when debugging)
sudo journalctl -u 'chatapp@*' --since '1 hour ago' -p warning --no-pager | less

# One-shot snapshot from your laptop (requires SSH key)
./scripts/ops/prod-observe.sh
# Optional: SINCE='24 hours ago' ./scripts/ops/prod-observe.sh
```

**Nginx** (upstream dead, timeouts) — always check alongside the app:

```bash
sudo tail -n 50 /var/log/nginx/error.log
sudo grep '\[error\]' /var/log/nginx/error.log | tail -n 20
# If logrotate ran, also check /var/log/nginx/error.log.1
```

**Correlate a dashboard spike with logs** (access uses `DD/Mon/YYYY`, errors use `YYYY/MM/DD`; VM clock is usually UTC):

```bash
# Example: Apr 8 grader window 19:00–22:00 on the server clock
./scripts/ops/prod-log-correlate.sh '08/Apr/2026' '2026/04/08' 19 22
```

If the UI is **US/Eastern**, shift hours (e.g. 20:00 EDT ≈ next calendar day 00:00 UTC).

### Health Monitoring

Set up alerting:
- Monitor `GET /health` every 30 seconds
- Alert if 503 or 5xx response
- Alert if timeout (service down)
- Set `ALERT_ENVIRONMENT=staging` on staging and `ALERT_ENVIRONMENT=production` on prod
- Put the matching `DISCORD_WEBHOOK_URL_STAGING=...` or `DISCORD_WEBHOOK_URL_PROD=...` in `/opt/chatapp/shared/.env`
- Redeploy or restart `alertmanager` + `prometheus` so Discord notifications go live
- `deploy-prod.sh` now validates Alertmanager webhook wiring and fails fast if it is blank/invalid (prevents silent alert loss)
- Use `http://127.0.0.1:9093` on the monitor host to verify active alerts and silences

**Dedicated database VM in Grafana / Prometheus:** By default, Prometheus on the **app** VM only scraped localhost (API, Redis, this VM’s `node_exporter`). To see **CPU / memory / disk** on the Postgres host and **`postgres_exporter`** metrics (connections, replication, bloat-related views, etc.), do this once:

1. On the **DB VM**, install exporters: `DB_SSH=root@<db-host> ./deploy/install-db-metrics-exporters.sh`  
   Restrict **:9100** and **:9187** in the cloud firewall / `ufw` to the **app VM’s private IP** only.
2. On the **next prod (or staging) deploy**, `deploy-prod.sh` / `deploy-staging.sh` sync `remote-compose.yml`, mount `file_sd/`, and run `deploy/prometheus-db-file-sd.py`, which builds scrape targets from **`PGDUMP_DATABASE_URL`** (direct `:5432` host). If that URL is missing or points at localhost, targets stay empty so all-in-one staging does not scrape junk addresses.
3. In Grafana → Explore → Prometheus, verify `up{job="db-node"} == 1` and `up{job="db-postgres"} == 1`, then use `node_*` metrics for the DB host and `pg_*` / `pg_stat_*` series from postgres_exporter.

### WebSocket Connections

After deployment, verify WebSocket stability:
- Check for broken connections in logs
- Monitor presence federation reliability
- Verify no connection drops during Nginx reload

## Environment Files

### Staging `.env` (when staging is restored)

Edit `/opt/chatapp/shared/.env` on staging VM:
- Point to staging database
- Point to staging Redis
- Use staging secrets (different from production)
- Set `NODE_ENV=staging`

### Production `.env`

Create `/opt/chatapp/shared/.env` on production VM:
- Point to production database
- Point to production Redis
- Use production secrets
- Set `NODE_ENV=production`

**Small VM (~2 GiB RAM) overload tuning** (optional; see `backend/src/utils/overload.ts`):
- Example: `OVERLOAD_RSS_WARN_MB=384`, `OVERLOAD_RSS_HIGH_MB=512`, `OVERLOAD_RSS_CRITICAL_MB=768`
- Enter HTTP shedding only if needed: `OVERLOAD_HTTP_SHED_ENABLED=true` (prefer fixing pool/CPU first)
- After edits: `sudo systemctl restart 'chatapp@*'`

**Fanout:** `FANOUT_QUEUE_CONCURRENCY` is written by `deploy-prod.sh` from VM shape; raise only after staging load tests show headroom.

**Channel `message:created`:** the app **defaults to** logical per-member user delivery, implemented internally via sharded Redis **`userfeed:<n>`** publishes that route to each socket’s **`user:<id>`** stream (see [`docs/architecture/grading-delivery-semantics.md`](../docs/architecture/grading-delivery-semantics.md)). Deploys now run [`deploy/apply-env-profile.py`](./apply-env-profile.py) against git-tracked required profiles ([`deploy/env/staging.required.env`](./env/staging.required.env), [`deploy/env/prod.required.env`](./env/prod.required.env)) so critical realtime keys (including `WS_AUTO_SUBSCRIBE_MODE=messages` and `READ_RECEIPT_DEFER_POOL_WAITING=0`) are deterministically enforced on every deploy. To change these intentionally, update the profile files in git and deploy that SHA (manual host-only `.env` edits will be overwritten for required keys).

### Course grader: “delivery fails” vs HTTP 403

**Throughput / delivery SLA (15s per listener, outage rollup):** see [`docs/architecture/grading-delivery-semantics.md`](../docs/architecture/grading-delivery-semantics.md) — maps the forum definition to WebSocket vs HTTP and lists common non-bug patterns.

Automated graders often count **`POST /api/v1/messages` without `201`** as a delivery failure. Your API returns **`403`** when the user may not post to that **private channel** or **conversation** (`Access denied` / `Not a participant`). That is **authorization**, not network or WebSocket failure. Under heavy grader traffic, **201 and 403 can each be ~half** of message POSTs if the harness mixes allowed and forbidden cases—or if clients post before join completes. Use `./scripts/ops/prod-observe.sh` (POST /messages status breakdown) and `./scripts/ops/prod-log-correlate.sh` for an hour-bucketed split.

**Ask your instructor explicitly:** does the leaderboard treat **expected `403`** on `POST /messages` as a *delivery fail*, or only **5xx / timeouts / missed WebSocket delivery**?

Both environments are identical in structure but differ in:
- Database credentials
- Redis credentials
- OAuth keys (if different)
- Log levels

## Troubleshooting

### Deploy fails: "Health check failed"

1. SSH to target and check logs:
   ```bash
   tail -50 /var/log/chatapp-candidate.log
   ```

2. Verify environment:
   - Database connectivity: `psql $DATABASE_URL`
   - Redis connectivity: `redis-cli -u $REDIS_URL ping`

3. Manual health check:
   ```bash
   ./deploy/health-check.sh 4001
   ```

### Deploy fails: "Database backup failed"

- This is non-fatal if you have recent snapshots elsewhere
- Proceed manually after verifying backups exist

### Rollback doesn't work

If you reverted Nginx but new version is still serving:
```bash
# Find and kill the candidate process
ssh ssperrottet@136.114.103.71 "pkill -f 'PORT=4001'"
# Then reload Nginx
ssh ssperrottet@136.114.103.71 "sudo systemctl reload nginx"
```

### WebSocket errors after deploy

- Clear browser cache (old frontend artifact)
- Check that Nginx is properly configured for WebSocket upgrades
- Monitor logs for connection drops

## Checklist: Before Every Production Deploy

- [ ] CI passed (all tests, builds green)
- [ ] Artifact built from locked `package-lock.json`
- [ ] VM3 canary plan defined for app-worker behavior changes
- [ ] Lease/singleton ownership check defined (if applicable)
- [ ] For DB/global config changes: maintenance-style rollout + rollback plan reviewed
- [ ] Prod database backup is recent and verified
- [ ] Rollback plan confirmed
- [ ] On-call person aware of deployment
- [ ] Team notified (if needed)
- [ ] Monitoring dashboard open during deploy

## Required Deploy Report (every production deploy)

- [ ] Exact commit SHA
- [ ] Files changed
- [ ] Tests run
- [ ] Deploy command
- [ ] Rollback command
- [ ] 5-15 minute gate results

## Checklist: During Production Deploy

- [ ] Run deploy script
- [ ] Watch for health failures during candidate startup
- [ ] Verify traffic switches to new version
- [ ] Monitor error rate for 5 minutes post-cutover
- [ ] Keep old version running for quick rollback
- [ ] Check that WebSocket connections are stable
- [ ] Verify presence reads/writes working

## Checklist: After Production Deploy

- [ ] `./scripts/ops/prod-nginx-audit.sh` passes (dual workers ⇒ both `:4000` and `:4001` in `upstream app`)

- [ ] Confirm all metrics normal
- [ ] No unusual error spikes
- [ ] WebSocket connections healthy
- [ ] Database queries performing normally
- [ ] Presence federation working
- [ ] Wait 10 minutes monitoring before cleanup
- [ ] Clean up old process and old release (optional)
- [ ] Update deployment log

## CI/CD Artifacts and Storage

All artifacts are tagged with SHA and stored in GitHub Releases for:
- Reproducibility: download exact same artifact for any deploy
- Audit trail: see which code version is in production
- Rollback: quickly re-deploy previous release by SHA

No rebuild happens for staging/prod deploys — use the exact CI artifact.

## Questions?

For deployment issues, check logs:
- **CI logs**: GitHub Actions → Workflow runs
- **Staging logs**: SSH to staging, `sudo journalctl -u 'chatapp@*' -f` and nginx under `/var/log/nginx/`
- **Prod logs**: SSH to `ubuntu@130.245.136.44`, then `sudo journalctl -u 'chatapp@*' …` (see **Observability** above) or run `./scripts/ops/prod-observe.sh`

For architectural questions, refer to the main [README.md](../README.md).
