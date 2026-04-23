'use strict';

/**
 * Client IP for abuse controls and logging.
 *
 * Nginx must set `X-Real-IP` to `$remote_addr` (single hop, not client-supplied
 * X-Forwarded-For chains). We prefer that header so app limits cannot be bypassed
 * by a forged `X-Forwarded-For: 10.x` when something mis-forwarded headers.
 *
 * `TRUST_NGINX_CLIENT_IP_HEADERS=false` — use only the TCP peer (integration / no nginx).
 */

function stripIpv4MappedPrefix(ip) {
  const s = String(ip || '').trim();
  if (s.startsWith('::ffff:')) return s.slice(7);
  return s;
}

function getTrustedClientIp(req) {
  if (process.env.TRUST_NGINX_CLIENT_IP_HEADERS === 'false') {
    return stripIpv4MappedPrefix(req.socket?.remoteAddress) || 'unknown';
  }

  const xr = req.headers['x-real-ip'];
  if (xr) {
    const raw = Array.isArray(xr) ? xr[0] : xr;
    const first = String(raw || '').split(',')[0].trim();
    if (first) return stripIpv4MappedPrefix(first);
  }

  if (typeof req.ip === 'string' && req.ip) {
    return stripIpv4MappedPrefix(req.ip);
  }

  return stripIpv4MappedPrefix(req.socket?.remoteAddress) || 'unknown';
}

/** RFC1918, loopback, CGNAT carrier-grade NAT (100.64/10), IPv6 loopback & ULA (fc/fd). */
function isPrivateOrInternalNetwork(ip) {
  const i = stripIpv4MappedPrefix(ip);
  if (!i || i === 'unknown') return false;
  if (i === '127.0.0.1' || i === '::1') return true;
  if (i.startsWith('10.')) return true;
  if (i.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(i)) return true;
  // 100.64.0.0 – 100.127.255.255 (RFC 6598)
  const m = /^100\.(\d+)\./.exec(i);
  if (m) {
    const second = Number(m[1]);
    if (second >= 64 && second <= 127) return true;
  }
  const il = i.toLowerCase();
  if (il.includes(':')) {
    if (il.startsWith('fe80:')) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(il)) return true;
  }
  return false;
}

module.exports = {
  getTrustedClientIp,
  isPrivateOrInternalNetwork,
  stripIpv4MappedPrefix,
};
