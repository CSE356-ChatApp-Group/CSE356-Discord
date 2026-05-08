# Edge / nginx migration plan (paper-only)

> **Status:** plan-only — no execution yet. Drafted 2026-05-08 after the OpenSearch-replica incident, when bottleneck analysis showed VM1 (`130.245.136.44`, internal `10.0.0.237`) saturated at ~68% CPU and `load1 / cpu_count ≈ 0.93` because it runs four roles on one box: edge nginx + TLS, PgBouncer, four `chatapp@4000-4003` Node workers, and MinIO. **Do not execute until reviewed.**

## Goal

Split the **edge** role off VM1 onto a dedicated **edge VM** so VM1 becomes app-worker-only. Preserve all existing upstreams, hostnames, TLS, and rollback paths.

## Current edge role on VM1 (truth, from `sudo grep ... /etc/nginx/sites-enabled/*`)

- `listen 80` and `listen 443 ssl` (`listen [::]:443 ssl ipv6only=on`)
- `server_name`:
  - `group-8.cse356.compas.cs.stonybrook.edu`  (canonical — TLS cert subject)
  - `group-8.cse.356.compas.cs.stonybrook.edu` (typo redirect, kept for compatibility)
  - `130.245.136.44` (raw-IP server block, HTTP only)
- `upstream app`     — HTTP API workers across vm1/vm2/vm3 (private IPs + worker ports)
- `upstream app_ws`  — websocket workers, currently the dedicated WSVM private IPs (`10.0.2.92`, `10.0.0.32`, `10.0.2.36`) when `CHATAPP_INV_WS_TIER_ENABLED=true`
- Local proxies on VM1 only:
  - `proxy_pass http://127.0.0.1:9000/`     — **MinIO S3 API** (currently bound to 127.0.0.1)
  - `proxy_pass http://127.0.0.1:3001`      — Grafana proxy on VM1 (only used in early bootstrap; superseded by monitoring VM)
  - `proxy_pass http://app/health`          — synthetic health
- `listen 127.0.0.1:18080` for nginx stub_status (read by `nginx-prometheus-exporter` on VM1)

## Target topology (after migration)

```
                        ┌──────────────────────────────┐
                        │  edge-vm (new)               │
   group-8.cse356…  ──▶ │  - nginx + certbot/TLS       │ ──▶  upstream app:    vm1/vm2/vm3:4000-4005
                        │  - admission-control         │ ──▶  upstream app_ws: wsvm1/wsvm2/wsvm3:4000-4005
                        │  - MinIO reverse proxy       │ ──▶  10.0.0.237:9000  (MinIO on VM1, rebound)
                        │  - nginx-prometheus-exporter │
                        │  - stub_status@127.0.0.1     │
                        └──────────────────────────────┘
                                                                ┌─────────────┐
                                                                │ vm1 (now    │
                                                                │ app-worker- │
                                                                │ only +      │
                                                                │ PgBouncer + │
                                                                │ MinIO)      │
                                                                └─────────────┘
```

Workers on VM1 stay at 4 (per the user's "Do not modify VM worker counts." constraint) until a separate decision moves to 6.

## Pre-flight (do these BEFORE cutover)

1. **Provision the edge VM.** Linode `g6-standard-4` (4 vCPU / 8 GB RAM, room to grow) is enough for nginx-only at current RPS; nginx CPU on VM1 is in the single digits today.
   - Internal: pick from same VPC range, e.g. `10.0.4.10/edge-vm`.
   - External: Linode-issued public IPv4 + IPv6 — **do not** reuse `130.245.136.44`.
2. **Bake nginx config from repo** (`infrastructure/nginx/nginx.conf`, `infrastructure/nginx/conf.d/admission-control.conf`, `deploy/nginx/admission-control-production.conf`, the patch scripts under `deploy/nginx/patches/`) into the new VM via the existing renderer in `deploy-prod-multi.sh` Phase 4 (the same code that currently writes nginx config on VM1). Repoint the renderer at edge-vm by adding `EDGE_VM_HOST` / `EDGE_VM_PRIVATE` knobs in `deploy/inventory-defaults.sh`. (No config changes happen on VM1 yet.)
3. **TLS:** install `certbot --nginx` on edge-vm and request a fresh Let's Encrypt cert for `group-8.cse356.compas.cs.stonybrook.edu`. Use **DNS-01** if HTTP-01 would conflict during cutover; otherwise issue the cert ahead of the DNS swap by temporarily pointing only `group-8.cse356.compas.cs.stonybrook.edu`'s `_acme-challenge` TXT record at edge-vm's challenge endpoint, or by using HTTP-01 from a temporary `:80` exposure on edge-vm before DNS flip (then validate `crt.sh` for the new chain). Keep the existing VM1 cert at `/etc/letsencrypt/live/...` so rollback can serve it.
4. **MinIO rebind on VM1.** Today MinIO listens on `127.0.0.1:9000` only. Add `--address :9000` (or `--address 10.0.0.237:9000` to constrain to the private interface) and update systemd unit. Add a UFW rule on VM1: allow `9000/tcp` from edge-vm private IP only. Verify upload + download from the new origin path. **This is a discrete change that can be tested in-place before any traffic moves**, because nginx on VM1 still proxies via `127.0.0.1:9000` regardless.
5. **PgBouncer audit.** Confirm none of the existing nginx server blocks proxy directly into PgBouncer (we know they don't — PgBouncer is for app→DB, not edge→app). PgBouncer stays on each app VM, untouched.
6. **Build a one-shot smoke harness.** Reuse `deploy/smoke-test.sh` (already covers the public hostname + websocket connect) but extend it to also exercise the MinIO presigned-URL path and at least one canary search request.

## Cutover (executed only after the above is green)

Do this **outside peak hours** and have a second operator on the call. Keep VM1 nginx running until the swap is verified.

| Step | Action | Verification |
|------|--------|--------------|
| C1 | Add edge-vm to Linode firewall + VPC ACLs: allow ingress TCP 80, 443; egress to VM1/VM2/VM3 (`9000`, `4000-4005`) and WSVMs (`4000-4005`). | `nc -zv 10.0.0.237 9000` and `nc -zv <ws-vm> 4000` from edge-vm |
| C2 | Pre-warm. Add edge-vm public IP to the **same** TLS cert (alt-name) by re-issuing on VM1 first, copy `/etc/letsencrypt/` to edge-vm, then start nginx on edge-vm listening only on port `:8443` (out-of-band) to avoid clashing. | `curl --resolve group-8.cse356.compas.cs.stonybrook.edu:8443:<edge-public-ip> https://group-8.cse356.compas.cs.stonybrook.edu:8443/health` returns 200 |
| C3 | Switch nginx on edge-vm from `:8443` to `:443`. (VM1 still answering as well — both edges live during the swap.) | `curl https://<edge-public-ip>/health` over real port works |
| C4 | **DNS flip.** Update the A record for `group-8.cse356.compas.cs.stonybrook.edu` from `130.245.136.44` → edge-vm public IPv4 (and AAAA for IPv6 if used). TTL: lower to 60s **24h before cutover** so the swap propagates fast; restore to 3600s after stable. | `dig +short group-8.cse356.compas.cs.stonybrook.edu @8.8.8.8`, repeat for `1.1.1.1` |
| C5 | Watch traffic shift. Both `nginx_http_requests_total` time series should be visible (VM1 dropping, edge-vm rising). Targets to watch: `chatapp_active_websockets`, `http_server_requests_total{job="chatapp-api"}`, MinIO bucket request count (S3 logs on VM1). | 5-min windows; expect ~100% on edge-vm within 30 minutes given DNS TTL |
| C6 | Disable VM1 nginx. **Do not delete files yet.** `sudo systemctl stop nginx; sudo systemctl disable nginx` so a reboot won't flap. Free port 443 on VM1 (good — frees vm1 for app workers). | `ss -ltn` on VM1 shows no listener on 443/80 |
| C7 | Update `nginx-prometheus-exporter` scrape: in `infrastructure/monitoring/prometheus-host.yml` move the `nginx` job to point at edge-vm private IP. | `up{job="nginx"} == 1` on edge-vm in Prometheus |
| C8 | Update `docs/infrastructure-inventory.md` with the new edge-vm entry **before** declaring done. | doc PR linked from the cutover notes |

## Rollback (any time during cutover)

- **DNS rollback:** flip A back to `130.245.136.44`. With TTL=60s, recovery is < 2 minutes globally.
- **VM1 nginx rollback:** `sudo systemctl enable --now nginx` on VM1 (config preserved). Stop nginx on edge-vm to avoid two edges holding the same cert.
- **MinIO rollback:** revert to `--address 127.0.0.1:9000` if the rebind itself was the failure (it shouldn't break anything; the proxy_pass on VM1 still uses 127.0.0.1).
- **TLS rollback:** the original cert on VM1 was kept; re-running `nginx -s reload` on VM1 restores TLS. If certbot already rotated only on edge-vm, force-renew on VM1 with `certbot renew --force-renewal --cert-name group-8.cse356.compas.cs.stonybrook.edu`.

## Things this plan **does not** change

- VM worker counts on VM1/VM2/VM3 stay at 4/6/6. Capacity gain on VM1 from offloading nginx is a separate decision.
- WSVM enablement flag (`CHATAPP_INV_WS_TIER_ENABLED`) stays where it is. `app_ws` upstream content is preserved verbatim.
- Search routing (`SEARCH_BACKEND`, `OPENSEARCH_*`) untouched.
- PgBouncer pools, sizes, listen addresses untouched.

## Open questions to resolve before scheduling

1. Edge VM region — must be **same Linode region** as VM1/VM2/VM3 to keep VPC private IP routing free. Confirm Linode bills VPC traffic the same way regardless of region pairs.
2. Whether to move `nginx-prometheus-exporter` to edge-vm (preferred — exporter colocated with nginx) vs. keep it on VM1 reading a remote stub_status (worse).
3. Renew automation — which user on edge-vm owns `certbot renew` (suggest `certbot.timer` running as root on edge-vm).
4. Coordinated maintenance window vs. low-TTL "any time" cutover. Prefer maintenance window because of S3 / MinIO cold path latency during the rebind.

## Estimated effort

- Pre-flight (provision + cert dry-run + smoke harness): 0.5 day.
- Cutover window (C1→C8): 1 hour, observed for 30 min after.
- Doc/inventory update + post-mortem fix-ups: 1 hour.
