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

echo "5) Writing Nginx reverse proxy config (80 -> localhost:4000)..."
sudo tee /etc/nginx/sites-available/chatapp > /dev/null <<'NGINX'
upstream chatapp_upstream {
  server 127.0.0.1:4000;
  keepalive 32;
}

server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;

  location / {
    proxy_pass http://chatapp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
  }

  location /health {
    proxy_pass http://chatapp_upstream/health;
    access_log off;
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
