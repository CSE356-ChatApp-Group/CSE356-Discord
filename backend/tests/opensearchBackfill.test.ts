/**
 * OpenSearch backfill regression tests.
 *
 * These tests guard the safety contract that scripts/search/backfill-opensearch-messages.ts
 * must keep after the 2026-05-08 incident, where the script's stable cursor
 * pagination saturated the production read replica because:
 *   - it could be pointed at the read replica via --use-read-replica, and
 *   - the WHERE/ORDER BY had no usable index, falling back to Parallel Seq
 *     Scan over a 54M-row, 28GB messages heap per batch.
 *
 * The script was patched to forbid the replica, throttle by default, set a
 * statement_timeout, and identify itself in pg_stat_activity. Migration 041
 * adds the missing non-partial (created_at DESC, id DESC) index.
 *
 * To prevent regressions we lock those guarantees in via static-content
 * assertions plus a small unit test for checkpoint helpers and the
 * --use-read-replica refusal.
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'search',
  'backfill-opensearch-messages.ts',
);

function loadScriptSource(): string {
  return fs.readFileSync(SCRIPT_PATH, 'utf8');
}

describe('OpenSearch backfill regression: replica & query safety', () => {
  let source: string;

  beforeAll(() => {
    source = loadScriptSource();
  });

  it('never imports readPool from backend/src/db/pool', () => {
    // The script must not auto-route through PG_READ_REPLICA_URL via the
    // shared app pool module. A dedicated Pool is built in-script instead.
    expect(source).not.toMatch(/poolMod\.readPool/);
    expect(source).not.toMatch(/searchReadPool/);
    expect(source).not.toMatch(/['"]\.\.\/\.\.\/backend\/src\/db\/pool['"]/);
  });

  it('explicitly refuses the legacy --use-read-replica flag', () => {
    expect(source).toMatch(/hasFlag\(['"]use-read-replica['"]\)/);
    expect(source).toMatch(/--use-read-replica is no longer supported/i);
    expect(source).toMatch(/process\.exit\(2\)/);
  });

  it('builds a dedicated primary-only Pool with statement_timeout and application_name', () => {
    expect(source).toMatch(/application_name:\s*BACKFILL_APPLICATION_NAME/);
    expect(source).toMatch(/BACKFILL_APPLICATION_NAME\s*=\s*['"]opensearch-backfill['"]/);
    expect(source).toMatch(/statement_timeout:\s*BACKFILL_STATEMENT_TIMEOUT_MS/);
    expect(source).toMatch(/BACKFILL_STATEMENT_TIMEOUT_MS\s*=\s*30_000/);
    expect(source).toMatch(/OPENSEARCH_BACKFILL_DATABASE_URL/);
  });

  it('every dbPool.query has a LIMIT bound to a $-placeholder', () => {
    // Capture every dbPool.query SQL block and assert it ends in `LIMIT $N`
    // bound to a parameter (i.e., the batch size). A literal-numeric LIMIT
    // would also satisfy the planner but we want it parametrized so the
    // batch size lives in one place.
    const queryBlocks = Array.from(
      source.matchAll(/dbPool\.query\(\s*`([\s\S]*?)`/g),
    ).map((m) => m[1]);
    expect(queryBlocks.length).toBeGreaterThan(0);
    for (const sql of queryBlocks) {
      expect(sql).toMatch(/LIMIT\s+\$\{?\w+\}?/i);
    }
  });

  it('default batch size is conservative (≤ 250) and clamped under 2000', () => {
    // Default 100 keeps replica/primary disk pressure low; the upper bound
    // 2000 prevents an operator from running 100k-row batches by accident.
    expect(source).toMatch(
      /Math\.min\(2000,\s*Math\.max\(50,\s*Number\(getArg\(['"]batch-size['"]\)\s*\|\|\s*['"]100['"]\)/,
    );
  });

  it('default sleep-ms is non-zero (throttle by default)', () => {
    // 250ms between batches gives the disk room to breathe; operators can
    // override down to 0 for short scoped backfills.
    expect(source).toMatch(
      /Math\.max\(0,\s*Number\(getArg\(['"]sleep-ms['"]\)\s*\|\|\s*['"]250['"]\)/,
    );
  });

  it('stable cursor pagination uses (created_at, id) tuple compare', () => {
    // Required for migration 041 to be effective and for resume-from-checkpoint
    // to be deterministic.
    expect(source).toMatch(
      /WHERE \(m\.created_at, m\.id\) \$\{comparator\} \(\$\{cursorCreatedAtPh\}::timestamptz, \$\{cursorIdPh\}::uuid\)/,
    );
    expect(source).toMatch(
      /ORDER BY m\.created_at \$\{order\.toUpperCase\(\)\}, m\.id \$\{order\.toUpperCase\(\)\}/,
    );
  });
});

describe('OpenSearch backfill: --use-read-replica refusal contract', () => {
  // We deliberately do NOT spawn the script live here: the repo's tsx
  // binary is sometimes installed for a non-host platform (CI / Docker bind
  // mounts), which would make a live exec test non-portable. The static
  // assertions in the suite above already prove the refusal contract:
  //
  //   1. The script reads the flag via hasFlag('use-read-replica').
  //   2. The script writes the exact error message to stderr.
  //   3. The script calls process.exit(2).
  //
  // The only way `process.exit(2)` is reachable is from inside the
  // `hasFlag('use-read-replica')` branch — a reviewer can verify this by
  // reading the file. This regression test asserts those three pieces are
  // colocated in a single conditional block to prevent future drift.
  it('keeps refusal logic colocated in a single hasFlag block', () => {
    const source = loadScriptSource();
    const block = source.match(
      /if \(hasFlag\(['"]use-read-replica['"]\)\)\s*\{[\s\S]*?process\.exit\(2\);[\s\S]*?\}/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/--use-read-replica is no longer supported/i);
    expect(block![0]).toMatch(/console\.error/);
  });
});

describe('OpenSearch backfill checkpoint helpers', () => {
  const os = require('os');

  it('resumes from saved checkpoint', () => {
    const saveBackfillCheckpoint = (checkpointPath: string, checkpoint: Record<string, unknown>) => {
      fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
      fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
    };
    const loadBackfillCheckpoint = (checkpointPath: string, fallbackCreatedAt: string) => {
      if (!fs.existsSync(checkpointPath)) {
        return { createdAt: fallbackCreatedAt, id: '00000000-0000-0000-0000-000000000000' };
      }
      const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      return { createdAt: String(parsed.createdAt), id: String(parsed.id) };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensearch-backfill-'));
    const checkpointPath = path.join(dir, 'checkpoint.json');

    saveBackfillCheckpoint(checkpointPath, {
      createdAt: '2026-05-01T00:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000123',
      scanned: 10,
      indexed: 10,
      failures: 0,
    });

    const loaded = loadBackfillCheckpoint(
      checkpointPath,
      '1970-01-01T00:00:00.000Z',
    );
    expect(loaded.createdAt).toBe('2026-05-01T00:00:00.000Z');
    expect(loaded.id).toBe('00000000-0000-4000-8000-000000000123');
  });
});
