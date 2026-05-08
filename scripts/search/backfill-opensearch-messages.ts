import { createRequire } from 'module';

const requireCjs = createRequire(__filename);
const poolMod = requireCjs('../../backend/src/db/pool');
const {
  bulkIndexMessagesToOpenSearch,
  ensureOpenSearchMessagesIndex,
} = requireCjs('../../backend/src/search/opensearchClient');

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
): { createdAt: string; id: string } {
  const fs = requireCjs('fs');
  try {
    if (!fs.existsSync(checkpointPath)) {
      return { createdAt: fallbackCreatedAt, id: '00000000-0000-0000-0000-000000000000' };
    }
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (parsed?.createdAt && parsed?.id) {
      return { createdAt: String(parsed.createdAt), id: String(parsed.id) };
    }
  } catch {
    // ignore parse/read errors and restart from fallback
  }
  return { createdAt: fallbackCreatedAt, id: '00000000-0000-0000-0000-000000000000' };
}

function saveBackfillCheckpoint(checkpointPath: string, checkpoint: Record<string, unknown>) {
  const fs = requireCjs('fs');
  const path = requireCjs('path');
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

async function main() {
  const orderArg = String(getArg('order') || 'desc').toLowerCase();
  const order: 'asc' | 'desc' = orderArg === 'asc' ? 'asc' : 'desc';
  const limit = Number(getArg('limit') || '0') || 0;
  const since = parseIsoMaybe(getArg('since'));
  const until = parseIsoMaybe(getArg('until'));
  const checkpointPath = getArg('checkpoint') || 'var/opensearch-backfill.checkpoint.json';
  const dryRun = hasFlag('dry-run');
  const batchSize = Math.min(500, Math.max(50, Number(getArg('batch-size') || '250') || 250));

  const checkpoint = loadBackfillCheckpoint(
    checkpointPath,
    order === 'asc'
      ? (since || '1970-01-01T00:00:00.000Z')
      : (until || '9999-12-31T23:59:59.999Z'),
  );
  let cursorCreatedAt = checkpoint.createdAt;
  let cursorId = checkpoint.id;

  if (!dryRun) {
    await ensureOpenSearchMessagesIndex();
  }

  let scanned = 0;
  let indexed = 0;
  let failures = 0;
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

    const { rows } = await poolMod.pool.query(
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
        await bulkIndexMessagesToOpenSearch(docs);
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
        checkpoint: { createdAt: cursorCreatedAt, id: cursorId, path: checkpointPath },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await poolMod.pool.end().catch(() => {});
  });
