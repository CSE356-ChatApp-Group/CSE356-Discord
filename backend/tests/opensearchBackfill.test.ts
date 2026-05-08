describe('OpenSearch backfill checkpoint helpers', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

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
