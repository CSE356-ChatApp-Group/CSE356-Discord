# deploy/deploy-prod-nginx-patches.sh
# Idempotent nginx site patches for prod edge. Sourced by deploy-prod.sh after ssh_prod
# and deploy-common.sh (CHATAPP_NGINX_* retry lines).
# shellcheck shell=bash

_chatapp_scp_deploy_script_prod_tmp() {
  local name="$1"
  chatapp_scp_to_prod "${SCRIPT_DIR}/nginx/patches/${name}" "${PROD_USER}@${PROD_HOST}:/tmp/${name}"
}

patch_nginx_search_location() {
  _chatapp_scp_deploy_script_prod_tmp patch-nginx-search-location.py
  ssh_prod "sudo python3 /tmp/patch-nginx-search-location.py --site-path '${CHATAPP_NGINX_SITE_PATH}' && sudo rm -f /tmp/patch-nginx-search-location.py"
}

patch_nginx_api_retry() {
  _chatapp_scp_deploy_script_prod_tmp patch-nginx-api-retry.py
  ssh_prod "sudo python3 /tmp/patch-nginx-api-retry.py --site-path '${CHATAPP_NGINX_SITE_PATH}' --retry-line '${CHATAPP_NGINX_PROXY_RETRY_LINE}' && sudo rm -f /tmp/patch-nginx-api-retry.py"
}

patch_nginx_auth_location() {
  _chatapp_scp_deploy_script_prod_tmp patch-nginx-auth-location.py
  ssh_prod "sudo python3 /tmp/patch-nginx-auth-location.py --site-path '${CHATAPP_NGINX_SITE_PATH}' && sudo rm -f /tmp/patch-nginx-auth-location.py"
}

patch_nginx_auth_flow_routes() {
  _chatapp_scp_deploy_script_prod_tmp patch-nginx-auth-flow-routes.py
  ssh_prod "sudo python3 /tmp/patch-nginx-auth-flow-routes.py --site-path '${CHATAPP_NGINX_SITE_PATH}' && sudo rm -f /tmp/patch-nginx-auth-flow-routes.py"
}

patch_nginx_auth_non_idempotent() {
  _chatapp_scp_deploy_script_prod_tmp patch-nginx-auth-non-idempotent.py
  ssh_prod "sudo python3 /tmp/patch-nginx-auth-non-idempotent.py --site-path '${CHATAPP_NGINX_SITE_PATH}' --retry-full '${CHATAPP_NGINX_PROXY_RETRY_LINE}' --retry-legacy '${CHATAPP_NGINX_PROXY_RETRY_LINE_LEGACY}' && sudo rm -f /tmp/patch-nginx-auth-non-idempotent.py"
}
