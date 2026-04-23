# Fail2ban: nginx rate-limit / edge 503 auto-ban (VM1)

Blocks **external** IPs that generate many **503** responses with **`urt=-`** in `access.log` (nginx-served errors, not upstream timing). Complements app-layer **`AUTO_IP_BAN`** (Redis) which keys off **429** from Express.

## Fix: regex must match real log format

Nginx combined + timing looks like:

```text
138.197.113.17 - - [23/Apr/2026:18:43:08 +0000] "GET / HTTP/1.1" 200 1693 "-" "curl/8.5.0" rt=0.000 urt=-
```

There is often **no space** between `]` and `"GET`. A pattern that requires `] ` (bracket, space, quote) **may never match**. The filter uses `\]\s*"` so both `]"GET` and `] "GET` match.

**Also:** `urt=-` appears on **200** lines too; the filter **requires `503`** so normal traffic is not matched.

## Install / refresh on the nginx host

```bash
SCRIPT_DIR=/path/to/chatapp/deploy/fail2ban
sudo install -m 0644 "$SCRIPT_DIR/filter.d/chatapp-nginx-ratelimit.conf" /etc/fail2ban/filter.d/
sudo install -m 0644 "$SCRIPT_DIR/jail.d/chatapp-nginx-ratelimit.local" /etc/fail2ban/jail.d/
sudo fail2ban-regex /var/log/nginx/access.log /etc/fail2ban/filter.d/chatapp-nginx-ratelimit.conf
sudo fail2ban-client reload
sudo fail2ban-client status chatapp-nginx-ratelimit
```

Synthetic test (should report **1** matched line):

```bash
printf '%s\n' '9.9.9.9 - - [23/Apr/2026:12:00:00 +0000]"GET / HTTP/1.1" 503 1693 "-" "curl/8.5.0" rt=0.000 urt=-' \
  | sudo fail2ban-regex - /etc/fail2ban/filter.d/chatapp-nginx-ratelimit.conf
```

## Persistence

`iptables` rules from fail2ban survive until reboot unless you use `iptables-persistent` / cloud security groups. Manual `iptables -I` rules are likewise non-persistent unless saved.
