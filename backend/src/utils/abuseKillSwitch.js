'use strict';

/**
 * Env-driven abuse / capacity kill switches (no DB / no Redis in this module).
 * Revert by unsetting env vars and redeploying.
 */

function parseBoolEnv(name, fallback = false) {
  const v = process.env[name];
  if (typeof v !== 'string') return fallback;
  const n = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(n)) return true;
  if (['0', 'false', 'no', 'off'].includes(n)) return false;
  return fallback;
}

/**
 * Effective token-bucket refill scale (1 = normal). When ABUSE_LIMIT_TIGHTEN=true,
 * refill rates are multiplied by ABUSE_LIMIT_TIGHTEN_FACTOR (default 0.5).
 */
function getAbuseLimitScale() {
  if (!parseBoolEnv('ABUSE_LIMIT_TIGHTEN', false)) return 1;
  const raw = Number(process.env.ABUSE_LIMIT_TIGHTEN_FACTOR || '0.5');
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return 0.5;
  return raw;
}

function isWsReplayDisabled() {
  return parseBoolEnv('DISABLE_WS_REPLAY', false);
}

/**
 * Comma-separated IPv4 CIDRs (e.g. 47.20.0.0/16,1.2.3.4/32) for app-layer 403.
 */
function parseBlockedSubnets() {
  const raw = process.env.BLOCK_SUBNETS || '';
  const out = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(s);
    if (!m) continue;
    const prefix = m[1];
    const bits = Number(m[2]);
    if (!Number.isFinite(bits) || bits < 0 || bits > 32) continue;
    out.push({ prefix, bits });
  }
  return out;
}

function ipv4ToInt(ip) {
  const p = String(ip || '').split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const oct of p) {
    const o = Number(oct);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) + o;
  }
  return n >>> 0;
}

function ipMatchesSubnet(ipInt, bits, prefixInt) {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (prefixInt & mask);
}

function isIpBlocked(clientIp) {
  const list = parseBlockedSubnets();
  if (!list.length) return false;
  const ipInt = ipv4ToInt(clientIp);
  if (ipInt == null) return false;
  for (const { prefix, bits } of list) {
    const pInt = ipv4ToInt(prefix);
    if (pInt == null) continue;
    if (ipMatchesSubnet(ipInt, bits, pInt)) return true;
  }
  return false;
}

module.exports = {
  getAbuseLimitScale,
  isWsReplayDisabled,
  isIpBlocked,
  parseBoolEnv,
};
