# deploy/deploy-common.sh
# Shared constants for deploy tooling (sourced by deploy-prod.sh, preflight-check.sh).
# shellcheck shell=bash

: "${CHATAPP_NGINX_SITE_PATH:=/etc/nginx/sites-available/chatapp}"

# Open-source nginx: POST retry to the next upstream requires the non_idempotent keyword
# on proxy_next_upstream (there is no separate proxy_next_upstream_non_idempotent directive).
# Include http_503 so that requests landing on a worker that is mid-shutdown (pool circuit
# breaker or Node draining) are retried on a healthy peer.  OVERLOAD_HTTP_SHED_ENABLED=false
# on prod, so overload-shedding 503s are never emitted and the max_fails concern is moot.
# Use proxy_next_upstream_tries 0 (nginx default semantics: try all peers in the group).
# tries=2 breaks multi-VM rolling deploys: least_conn can pick two restarting workers →
# connect() refused to upstream while other workers are healthy.
CHATAPP_NGINX_PROXY_RETRY_LINE='proxy_next_upstream error timeout http_502 http_503 http_504 non_idempotent;'
CHATAPP_NGINX_PROXY_RETRY_LINE_LEGACY='proxy_next_upstream error timeout http_502 http_503 http_504 non_idempotent;'
