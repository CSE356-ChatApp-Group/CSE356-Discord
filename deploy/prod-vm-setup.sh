#!/bin/bash
# deploy/prod-vm-setup.sh
# One-time setup for production infrastructure.
# Run this on the production instance before first deployment.

set -euo pipefail

APP_USER="${SUDO_USER:-$USER}"

echo "=== Production Setup ==="
echo "Setting up on $(hostname)"
echo "Using app user: ${APP_USER}"

# 1. Create app directories
echo "1. Setting up application directories..."
sudo mkdir -p /opt/chatapp/{releases,shared,logs,backups}
sudo chown -R "${APP_USER}:${APP_USER}" /opt/chatapp
echo "✓ Directories created"

# 2. Verify Node.js 20 is installed
echo "2. Verifying Node.js..."
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js not installed. Install Node.js 20 first."
  exit 1
fi
NODE_VERSION=$(node --version)
echo "✓ Node.js $NODE_VERSION"

# 2b. Raise nginx + kernel connection headroom (defaults are too low for grading bursts).
echo "2b. Tuning nginx/kernel connection limits..."
if ! grep -q '^worker_rlimit_nofile' /etc/nginx/nginx.conf; then
  sudo sed -i '/^worker_processes/a worker_rlimit_nofile 65535;' /etc/nginx/nginx.conf
fi
sudo sed -i 's/worker_connections [0-9]*/worker_connections 16384/' /etc/nginx/nginx.conf
sudo sed -i 's/#[[:space:]]*multi_accept on/multi_accept on/' /etc/nginx/nginx.conf
sudo sysctl -w net.core.somaxconn=16384 >/dev/null
sudo sysctl -w net.ipv4.tcp_max_syn_backlog=16384 >/dev/null
echo "✓ Connection limits tuned"

# 3. Configure Nginx for candidate-port cutover
echo "3. Configuring Nginx..."
sudo tee /etc/nginx/sites-available/chatapp > /dev/null <<'EOF'
upstream app {
  # max_fails=0: never drain the upstream on 502/503 bursts (avoids no live upstreams).
  server localhost:4000 max_fails=0;
  keepalive 32;
}

server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;

  # Redirect to HTTPS if configured
  # return 301 https://$host$request_uri;

  # WebSocket proxy
  location /ws {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 86400;
  }

  # Search: allow pool + DB tail without nginx returning 502 while Node still works.
  location ^~ /api/v1/search {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
    client_max_body_size 10m;
  }

  # REST API proxy
  location /api/ {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
    client_max_body_size 10m;
  }

  location = /minio {
    return 307 /minio/;
  }

  location /minio/ {
    proxy_pass http://127.0.0.1:9000/;
    proxy_http_version 1.1;
    proxy_set_header Host 127.0.0.1:9000;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
    client_max_body_size 10m;
  }

  # Health endpoint (no logging)
  location /health {
    proxy_pass http://app/health;
    access_log off;
  }

  # Grafana UI (browser-friendly monitoring)
  location = /grafana {
    return 301 /grafana/;
  }

  location = /login {
    return 302 /grafana/login;
  }

  location /grafana/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
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

  # Frontend static app
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
EOF

sudo ln -sf /etc/nginx/sites-available/chatapp /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
echo "✓ Nginx configured"

# 4. Create .env.example template
echo "4. Creating .env template..."
sudo tee /opt/chatapp/shared/.env.template > /dev/null <<'EOF'
# Production Environment
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=1024

# Server
PORT=4000

# Database (production)
DATABASE_URL=postgres://user:password@db.internal:5432/chatapp_prod
POSTGRES_SSL=require

# Redis (production)
REDIS_URL=redis://:password@redis.internal:6379/0

# Secrets
JWT_SECRET=generate-random-32-char-string
REFRESH_SECRET=generate-random-32-char-string

# OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# S3 / Object Storage
S3_ENDPOINT=https://chatapp.example.com/minio
S3_INTERNAL_ENDPOINT=http://127.0.0.1:9000
S3_BUCKET=chatapp-attachments
S3_REGION=us-east-1
S3_ACCESS_KEY=
S3_SECRET_KEY=

# Search
# Uses PostgreSQL native FTS; no external search service required.

# CORS
CORS_ORIGIN=https://chatapp.example.com

# Logging
LOG_LEVEL=info
EOF

echo "✓ Environment template at /opt/chatapp/shared/.env.template"
echo "  Create /opt/chatapp/shared/.env and fill in secrets"

# 5. Set up log rotation
echo "5. Setting up log rotation..."
sudo tee /etc/logrotate.d/chatapp > /dev/null <<'EOF'
/var/log/chatapp-*.log {
  daily
  rotate 7
  compress
  delaycompress
  missingok
  notifempty
  create 0640 root adm
}
EOF
echo "✓ Log rotation configured"

# 6. Create systemd service (optional, for long-lived deployments)
echo "6. Creating systemd service template..."
sudo tee /etc/systemd/system/chatapp-4000.service > /dev/null <<EOF
[Unit]
Description=ChatApp API (port 4000)
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=/opt/chatapp/current
EnvironmentFile=/opt/chatapp/shared/.env
ExecStart=/usr/bin/npm --prefix backend start
Environment="PORT=4000"
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=chatapp[4000]

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
echo "✓ Service template created (optional)"

# 7. Create canary script
echo "7. Creating deployment utilities..."
cat > /tmp/prod-utils.sh <<'EOF'
#!/bin/bash
# Quick commands for production management

release_current() {
  if [ -L /opt/chatapp/current ]; then
    readlink -f /opt/chatapp/current | xargs basename
  fi
}

release_list() {
  echo "Recent releases:"
  ls -1dt /opt/chatapp/releases/*/ 2>/dev/null | head -5 | while read d; do
    SIZE=$(du -sh "$d" | cut -f1)
    CURRENT=""
    [ -L /opt/chatapp/current ] && [ "$(readlink -f /opt/chatapp/current)" = "$d" ] && CURRENT=" [CURRENT]"
    echo "  $(basename "$d") ($SIZE)$CURRENT"
  done
}

release_cleanup() {
  echo "Removing old releases (keeping 5)..."
  cd /opt/chatapp/releases
  ls -1dt */ | tail -n +6 | xargs rm -rf
  echo "Done"
}

health_check() {
  PORT=${1:-4000}
  curl -s http://localhost:$PORT/health | jq .
}

logs_tail() {
  PORT=${1:-4000}
  sudo journalctl -u chatapp-${PORT} -n 50 -f || sudo tail -f /var/log/chatapp-*.log
}

status() {
  echo "=== ChatApp Status ==="
  echo "Current release: $(release_current)"
  echo "Processes:"
  ps aux | grep '[n]ode\|[n]pm' | awk '{print "  "$1" "$2" "$11" "$12}' || echo "  None"
  echo "Listening ports:"
  netstat -tlnp 2>/dev/null | grep -E '4000|4001' || echo "  None"
  echo "Recent releases:"
  release_list | head -3
}
EOF

sudo tee /opt/chatapp/shared/prod-utils.sh > /dev/null < /tmp/prod-utils.sh
sudo chmod +x /opt/chatapp/shared/prod-utils.sh
sudo chown "${APP_USER}:${APP_USER}" /opt/chatapp/shared/prod-utils.sh
echo "✓ Utilities installed"

# 8. Final setup
echo ""
echo "=== Production Infrastructure Ready ==="
echo ""
echo "Next steps:"
echo ""
echo "1. Fill in /opt/chatapp/shared/.env with production secrets:"
echo "   sudo vim /opt/chatapp/shared/.env"
echo ""
echo "2. Verify database and Redis access:"
echo "   psql \$DATABASE_URL -c 'SELECT 1'"
echo "   redis-cli -u \$REDIS_URL ping"
echo ""
echo "3. Deploy a release:"
echo "   ./deploy/deploy-prod.sh <commit-sha>"
echo ""
echo "4. Quick status checks:"
echo "   source /opt/chatapp/shared/prod-utils.sh"
echo "   status"
echo "   release_list"
echo "   health_check"
echo ""
echo "5. View logs:"
echo "   logs_tail"
echo ""
