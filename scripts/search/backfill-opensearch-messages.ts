/**
 * OpenSearch messages backfill (operator-run, primary-only).
 *
 * Reads `messages` rows in stable cursor order (created_at DESC, id DESC) and
 * bulk-indexes them into OpenSearch. Designed to be re-runnable from a
 * checkpoint file.
 *
 * Hard guarantees (regression-tested in backend/tests/opensearchBackfill.test.ts):
 *
 *   1. Always primary. The script never imports `readPool` from
 *      backend/src/db/pool.ts, and the legacy `--use-read-replica` flag is
 *      explicitly refused. Operators wanting a non-default DSN must set
 *      OPENSEARCH_BACKFILL_DATABASE_URL (e.g. a dedicated heavy-read pool
 *      that is *not* the shared application replica). On 2026-05-08 this
 *      script — when run with --use-read-replica — saturated the prod read
 *      replica's vdb at 96% utilization and pushed replay lag to ~5s because
 *      the cursor query had no usable index and fell back to Parallel Seq Scan
 *      on a 54M-row, 28GB messages table. See the matching investigation
 *      notes in docs/operations-monitoring.md and migration 041.
 *
 *   2. Bounded per-batch. Every SQL execution has a LIMIT bound to
 *      --batch-size (default 100, max 2000) AND a 30s session-level
 *      statement_timeout, so a missing index can never silently mass-scan.
 *
 *   3. Identifiable. The script's pg connections set
 *      application_name='opensearch-backfill' so they are visible in
 *      pg_stat_activity and easy to cancel.
 *
 *   4. Throttled by default. --sleep-ms defaults to 250ms between batches so
 *      a long backfill does not pin disk continuously.
 *
 * Usage:
 *   tsx scripts/search/backfill-opensearch-messages.ts \
 *     --checkpoint var/opensearch-backfill.checkpoint.json \
 *     --batch-size 100 --sleep-ms 250
 *
 *   # Dry run, scoped to last 24h, capped at 5k rows:
 *   tsx scripts/search/backfill-opensearch-messages.ts \
 *     --dry-run --since 2026-05-07T00:00:00Z --limit 5000
 *
 * Required SQL plan: cursor `(m.created_at, m.id) < ($cursor_ts, $cursor_id)`
 * ORDER BY (created_at DESC, id DESC) LIMIT $batch needs a non-partial
 * btree on messages(created_at DESC, id DESC) — see migration 041.
 */

import { createRequire } from 'module';

const requireCjs = createRequire(__filename);
const { Pool } = requireCjs('pg');

// OpenSearch client is loaded lazily inside main() (after the
// --use-read-replica refusal check) so that operators who pass the legacy
// flag get the clean refusal exit even when OPENSEARCH_URL is unset/bogus.
type OpenSearchModule = {
  bulkIndexMessagesToOpenSearch: (docs: unknown[]) => Promise<void>;
  ensureOpenSearchMessagesIndex: () => Promise<void>;
};

type Row = {
  id: string;
  content: string;
  author_id: string;
  channel_id: string | null;
  conversation_id: string | null;
  community_id: string | null;
  created_at: string;
  created_at_cursor: string;
  updated_at: string | null;
  deleted_at: string | null;
};

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseIsoMaybe(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function loadBackfillCheckpoint(
  checkpointPath: string,
  fallbackCreatedAt: string,
): {
  createdAt: string;
  id: string;
  scanned: number;
  indexed: number;
  failures: number;
} {
  const fs = requireCjs('fs');
  const emptyId = '00000000-0000-0000-0000-000000000000';
  try {
    if (!fs.existsSync(checkpointPath)) {
      return { createdAt: fallbackCreatedAt, id: emptyId, scanned: 0, indexed: 0, failures: 0 };
    }
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (parsed?.createdAt && parsed?.id) {
      return {
        createdAt: String(parsed.createdAt),
        id: String(parsed.id),
        scanned: Number.isFinite(Number(parsed.scanned)) ? Number(parsed.scanned) : 0,
        indexed: Number.isFinite(Number(parsed.indexed)) ? Number(parsed.indexed) : 0,
        failures: Number.isFinite(Number(parsed.failures)) ? Number(parsed.failures) : 0,
      };
    }
  } catch {
    // ignore parse/read errors and restart from fallback
  }
  return { createdAt: fallbackCreatedAt, id: emptyId, scanned: 0, indexed: 0, failures: 0 };
}

function saveBackfillCheckpoint(checkpointPath: string, checkpoint: Record<string, unknown>) {
  const fs = requireCjs('fs');
  const path = requireCjs('path');
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

const BACKFILL_APPLICATION_NAME = 'opensearch-backfill';
const BACKFILL_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Dedicated, primary-only Pool. We deliberately do not import the shared
 * pool from backend/src/db/pool.ts so that:
 *   - this script can never select PG_READ_REPLICA_URL,
 *   - we can apply per-session statement_timeout without affecting the
 *     long-running app pool,
 *   - the connection is identifiable in pg_stat_activity by app name.
 *
 * Operators who want to run against an alternative DSN (e.g. a dedicated
 * "heavy-read" pool that is not the live replica) can set
 * OPENSEARCH_BACKFILL_DATABASE_URL. There is no way to point this at the
 * application read replica through env alone.
 */
function buildBackfillPool(): InstanceType<typeof Pool> {
  const connectionString =
    process.env.OPENSEARCH_BACKFILL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'opensearch-backfill: DATABASE_URL (or OPENSEARCH_BACKFILL_DATABASE_URL) must be set',
    );
  }
  return new Pool({
    connectionString,
    max: 2,
    application_name: BACKFILL_APPLICATION_NAME,
    statement_timeout: BACKFILL_STATEMENT_TIMEOUT_MS,
    keepAlive: false,
  });
}

async function main() {
  if (hasFlag('use-read-replica')) {
    console.error(
      'opensearch-backfill: --use-read-replica is no longer supported. ' +
        'This script saturated the read replica on 2026-05-08 (replica disk 96% util, replay lag 5s) ' +
        'because the cursor query had no usable index. Run against the primary, or set ' +
        'OPENSEARCH_BACKFILL_DATABASE_URL to a dedicated heavy-read DSN.',
    );
    process.exit(2);
  }

  const orderArg = String(getArg('order') || 'desc').toLowerCase();
  const order: 'asc' | 'desc' = orderArg === 'asc' ? 'asc' : 'desc';
  const limit = Number(getArg('limit') || '0') || 0;
  const since = parseIsoMaybe(getArg('since'));
  const until = parseIsoMaybe(getArg('until'));
  const checkpointPath = getArg('checkpoint') || 'var/opensearch-backfill.checkpoint.json';
  const dryRun = hasFlag('dry-run');
  const batchSize = Math.min(2000, Math.max(50, Number(getArg('batch-size') || '100') || 100));
  const sleepMs = Math.min(60_000, Math.max(0, Number(getArg('sleep-ms') || '250') || 250));

  const dbPool = buildBackfillPool();

  // Lazy-load OpenSearch client only after the flag/DSN guards have passed.
  const opensearch: OpenSearchModule = requireCjs(
    '../../backend/src/search/opensearchClient',
  );

  const checkpoint = loadBackfillCheckpoint(
    checkpointPath,
    order === 'asc'
      ? (since || '1970-01-01T00:00:00.000Z')
      : (until || '9999-12-31T23:59:59.999Z'),
  );
  let cursorCreatedAt = checkpoint.createdAt;
  let cursorId = checkpoint.id;

  if (!dryRun) {
    await opensearch.ensureOpenSearchMessagesIndex();
  }

  let scanned = checkpoint.scanned;
  let indexed = checkpoint.indexed;
  let failures = checkpoint.failures;
  const startedAt = Date.now();

  while (true) {
    const params: any[] = [];
    const comparator = order === 'asc' ? '>' : '<';
    const cursorCreatedAtPh = `$${params.push(cursorCreatedAt)}`;
    const cursorIdPh = `$${params.push(cursorId)}`;
    const limitPh = `$${params.push(batchSize)}`;

    const boundaryParts: string[] = [];
    if (since) boundaryParts.push(`AND m.created_at >= $${params.push(since)}::timestamptz`);
    if (until) boundaryParts.push(`AND m.created_at <= $${params.push(until)}::timestamptz`);

    const { rows } = await dbPool.query(
      `
      SELECT
        m.id,
        m.content,
        m.author_id,
        m.channel_id,
        m.conversation_id,
        ch.community_id,
        m.created_at,
        to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at_cursor,
        m.updated_at,
        m.deleted_at
      FROM messages m
      LEFT JOIN channels ch ON ch.id = m.channel_id
      WHERE (m.created_at, m.id) ${comparator} (${cursorCreatedAtPh}::timestamptz, ${cursorIdPh}::uuid)
      ${boundaryParts.join('\n      ')}
      ORDER BY m.created_at ${order.toUpperCase()}, m.id ${order.toUpperCase()}
      LIMIT ${limitPh}
      `,
      params,
    );
    if (!rows.length) break;

    const batch = rows as Row[];
    scanned += batch.length;
    if (limit > 0 && scanned > limit) {
      batch.length = Math.max(0, batch.length - (scanned - limit));
      scanned = limit;
    }

    const docs = batch.map((row) => ({
      id: row.id,
      content: row.content,
      authorId: row.author_id,
      channelId: row.channel_id,
      communityId: row.community_id,
      conversationId: row.conversation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    }));

    if (!dryRun && docs.length > 0) {
      try {
        await opensearch.bulkIndexMessagesToOpenSearch(docs);
        indexed += docs.length;
      } catch {
        failures += docs.length;
      }
    } else {
      indexed += docs.length;
    }

    const last = batch[batch.length - 1];
    cursorCreatedAt = String(last.created_at_cursor);
    cursorId = last.id;

    try {
      saveBackfillCheckpoint(checkpointPath, {
        createdAt: cursorCreatedAt,
        id: cursorId,
        scanned,
        indexed,
        failures,
      });
    } catch {
      // best effort
    }

    const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
    const dps = (indexed / elapsedSec).toFixed(1);
    console.log(`progress scanned=${scanned} indexed=${indexed} failures=${failures} docs_per_sec=${dps}`);
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
    if (limit > 0 && scanned >= limit) break;
  }

  const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
  console.log(
    JSON.stringify(
      {
        dryRun,
        scanned,
        indexed,
        failures,
        docsPerSec: Number((indexed / elapsedSec).toFixed(2)),
        batchSize,
        sleepMs,
        applicationName: BACKFILL_APPLICATION_NAME,
        statementTimeoutMs: BACKFILL_STATEMENT_TIMEOUT_MS,
        checkpoint: { createdAt: cursorCreatedAt, id: cursorId, path: checkpointPath },
      },
      null,
      2,
    ),
  );

  await dbPool.end().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
