# deploy/deploy-common.sh
# Shared constants for deploy tooling (sourced by deploy-prod.sh, preflight-check.sh).
# shellcheck shell=bash

: "${CHATAPP_NGINX_SITE_PATH:=/etc/nginx/sites-available/chatapp}"

# Open-source nginx: POST retry to the next upstream requires the non_idempotent keyword
# on proxy_next_upstream (there is no separate proxy_next_upstream_non_idempotent directive).
# Keep 503 out of retry policy so app overload 503 responses do not mark peers as failed.
CHATAPP_NGINX_PROXY_RETRY_LINE='proxy_next_upstream error timeout http_502 http_504 non_idempotent;'
CHATAPP_NGINX_PROXY_RETRY_LINE_LEGACY='proxy_next_upstream error timeout http_502 http_503 http_504 non_idempotent;'
