#!/usr/bin/env node
/**
 * Aggregate slow_http_request_trace JSON lines (stdin or files).
 *
 * Input: one JSON object per line (pino / journal JSON), or nested JSON in "MESSAGE=" fields.
 * Filters: event === "slow_http_request_trace"
 *
 * Usage:
 *   journalctl -u 'chatapp@*' --since '15 min ago' -o json | jq -r '.MESSAGE' | \
 *     node scripts/ops/aggregate-slow-http-traces.cjs
 *   node scripts/ops/aggregate-slow-http-traces.cjs traces.ndjson
 *
 * Env:
 *   SLOW_TRACE_TOP_N  (default 25) — rows in ranked table
 */

'use strict';

const fs = require('fs');
const readline = require('readline');

const TOP_N = Math.min(200, Math.max(1, parseInt(process.env.SLOW_TRACE_TOP_N || '25', 10) || 25));

/** @typedef {{ count: number, db_sum_ms: number, db_max_single_ms: number, db_query_count: number, app_wall_ms_estimated: number, app_wall_n: number, total_wall_ms: number, overlap: number }} Agg */

/** @param {string} line */
function parseLine(line) {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** @param {any} obj */
function isTrace(obj) {
  return obj && obj.event === 'slow_http_request_trace';
}

/** @param {Map<string, Agg>} m */
function bump(m, route, fields) {
  let a = m.get(route);
  if (!a) {
    a = {
      count: 0,
      db_sum_ms: 0,
      db_max_single_ms: 0,
      db_query_count: 0,
      app_wall_ms_estimated: 0,
      app_wall_n: 0,
      total_wall_ms: 0,
      overlap: 0,
    };
    m.set(route, a);
  }
  a.count += 1;
  a.db_sum_ms += Number(fields.db_sum_ms) || 0;
  a.db_max_single_ms = Math.max(a.db_max_single_ms, Number(fields.db_max_single_ms) || 0);
  a.db_query_count += Number(fields.db_query_count) || 0;
  const app = fields.app_wall_ms_estimated;
  if (app !== undefined && app !== null && Number.isFinite(Number(app))) {
    a.app_wall_ms_estimated += Number(app);
    a.app_wall_n += 1;
  }
  a.total_wall_ms += Number(fields.total_wall_ms) || 0;
  if (fields.db_wall_parallel_overlap_hint) a.overlap += 1;
}

async function main() {
  const files = process.argv.slice(2);
  /** @type {Map<string, Agg>} */
  const byRoute = new Map();

  async function consumeStream(stream) {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      let obj = parseLine(line);
      if (!obj) continue;
      if (!isTrace(obj) && obj.MESSAGE) {
        try {
          obj = JSON.parse(obj.MESSAGE);
        } catch {
          continue;
        }
      }
      if (!isTrace(obj)) continue;
      const route = String(obj.route || '(no route)');
      bump(byRoute, route, obj);
    }
  }

  if (files.length === 0) {
    await consumeStream(process.stdin);
  } else {
    for (const f of files) {
      await consumeStream(fs.createReadStream(f, { encoding: 'utf8' }));
    }
  }

  const rows = [...byRoute.entries()].map(([route, a]) => ({
    route,
    count: a.count,
    db_sum_ms_avg: a.count ? a.db_sum_ms / a.count : 0,
    db_max_single_ms_max: a.db_max_single_ms,
    db_query_count_avg: a.count ? a.db_query_count / a.count : 0,
    app_wall_ms_estimated_avg: a.app_wall_n ? a.app_wall_ms_estimated / a.app_wall_n : null,
    total_wall_ms_avg: a.count ? a.total_wall_ms / a.count : 0,
    overlap_hint_count: a.overlap,
  }));

  rows.sort((x, y) => y.db_sum_ms_avg * y.count - x.db_sum_ms_avg * x.count);

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), routes: rows.slice(0, TOP_N) }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
