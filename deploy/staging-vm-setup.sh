#!/bin/bash
# deploy/staging-vm-setup.sh
# One-time bootstrap for staging VM (Google Compute Engine).
# Safe to rerun; does not deploy or start application code.

set -euo pipefail

NODE_MAJOR="20"

echo "=== Staging VM Bootstrap ==="
echo "Host: $(hostname)"

echo "1) Installing base packages..."
sudo apt-get update
sudo apt-get install -y curl ca-certificates gnupg git nginx redis-server

echo "2) Installing Node.js ${NODE_MAJOR}.x (match prod runtime)..."
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v${NODE_MAJOR}\\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "3) Installing PM2 globally..."
sudo npm install -g pm2

echo "4) Creating base directories..."
sudo mkdir -p /opt/chatapp/releases /opt/chatapp/shared
sudo chown -R "$USER":"$USER" /opt/chatapp

echo "5) Writing Nginx config (frontend static + backend proxy)..."
sudo install -d -m 0755 /etc/nginx/conf.d
sudo install -m 0644 "$(dirname "$0")/nginx/admission-control.conf" /etc/nginx/conf.d/admission-control.conf
sudo tee /etc/nginx/sites-available/chatapp > /dev/null <<'NGINX'
upstream chatapp_upstream {
  server 127.0.0.1:4000;
  keepalive 32;
}

server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;

  location /ws {
    limit_req zone=external_ws burst=20 nodelay;
    limit_conn external_expensive_conns 5;
    proxy_pass http://chatapp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
  }

  location ~ ^/api/v1(/api/v1)+(.*)$ {
    rewrite ^ /api/v1$2 last;
  }

  location ^~ /api/v1/search {
    limit_req zone=external_expensive burst=50 nodelay;
    limit_conn external_expensive_conns 5;
    proxy_pass http://chatapp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
    client_max_body_size 10m;
  }

  location ^~ /api/v1/auth/ {
    limit_req zone=external_auth burst=3 nodelay;
    proxy_pass http://chatapp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Request-Id $request_id;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_next_upstream error timeout http_502 http_504 non_idempotent;
    proxy_next_upstream_tries 2;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    client_max_body_size 10m;
  }

  location ~ ^/api/v1/communities/[^/]+/join/?$ {
    limit_req zone=community_join_direct burst=60 nodelay;
    limit_conn external_expensive_conns 5;
    proxy_pass http://chatapp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Request-Id $request_id;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_next_upstream error timeout http_502 http_504 non_idempotent;
    proxy_next_upstream_tries 2;
    proxy_read_timeout 30s;
    client_max_body_size 10m;
  }

  # Exact URI avoids nginx normalizing POST /communities to /communities/.
  location = /api/v1/communities {
    limit_req zone=external_general burst=200 nodelay;
    limit_conn external_conns 30;
    proxy_pass http://chatapp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_next_upstream error timeout http_502 http_504 non_idempotent;
    proxy_next_upstream_tries 2;
    proxy_read_timeout 30s;
    client_max_body_size 10m;
  }

  location /api/ {
    limit_req zone=external_general burst=200 nodelay;
    limit_conn external_conns 30;
    proxy_pass http://chatapp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_next_upstream error timeout http_502 http_504 non_idempotent;
    proxy_next_upstream_tries 2;
    proxy_read_timeout 30s;
    client_max_body_size 10m;
  }

  location /health {
    proxy_pass http://chatapp_upstream/health;
    access_log off;
  }

  location = /minio {
    return 307 /minio/;
  }

  location /minio/ {
    proxy_pass              http://127.0.0.1:9000/;
    proxy_http_version      1.1;
    proxy_set_header        Host 127.0.0.1:9000;
    proxy_set_header        X-Real-IP \$remote_addr;
    proxy_set_header        X-Forwarded-For \$remote_addr;
    proxy_set_header        X-Forwarded-Proto \$scheme;
    proxy_buffering         off;
    proxy_request_buffering off;
    proxy_read_timeout      300s;
    client_max_body_size    10m;
  }

  location = /grafana {
    return 301 /grafana/;
  }

  location /grafana/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Prefix /grafana;
    # Keep Grafana redirects on a single /grafana prefix across older and newer
    # nginx versions. Older nginx builds may still absolutize /grafana/login
    # into /grafana/grafana/login unless we rewrite localhost + relative
    # redirects explicitly.
    proxy_redirect http://127.0.0.1:3001/ /;
    proxy_redirect http://localhost/ /;
    proxy_redirect ~^/(.*)$ /$1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
  }

  location / {
    root /opt/chatapp/current/frontend/dist;
    try_files $uri /index.html;
  }

  location = /index.html {
    root /opt/chatapp/current/frontend/dist;
    add_header Cache-Control "no-store";
  }

  location /assets/ {
    root /opt/chatapp/current/frontend/dist;
    try_files $uri =404;
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
  }
}
NGINX

sudo ln -sfn /etc/nginx/sites-available/chatapp /etc/nginx/sites-enabled/chatapp
sudo rm -f /etc/nginx/sites-enabled/default

echo "6) Validating and reloading Nginx..."
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl reload nginx || sudo systemctl restart nginx

echo "7) Enabling and starting redis-server..."
sudo systemctl enable redis-server
sudo systemctl restart redis-server

echo "8) Ensuring shared env file exists (runtime shape parity with prod)..."
if [ ! -f /opt/chatapp/shared/.env ]; then
  cat > /opt/chatapp/shared/.env <<'ENV'
NODE_ENV=staging
PORT=4000
DATABASE_URL=postgres://<user>:<pass>@<host>:5432/chatapp_staging
REDIS_URL=redis://127.0.0.1:6379/0
JWT_SECRET=replace-me
REFRESH_SECRET=replace-me
CORS_ORIGIN=http://localhost
ENV
  chmod 600 /opt/chatapp/shared/.env
fi

echo "Bootstrap complete."
echo "- Installed: node, nginx, redis-server, git, pm2"
echo "- Created: /opt/chatapp/releases, /opt/chatapp/shared"
echo "- Not performed: repo clone, dependency install, app start"
