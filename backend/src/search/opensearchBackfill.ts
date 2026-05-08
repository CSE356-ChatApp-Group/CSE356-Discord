const fs = require('fs');
const path = require('path');

type Checkpoint = {
  createdAt: string;
  id: string;
  scanned?: number;
  indexed?: number;
  failures?: number;
};

function loadBackfillCheckpoint(
  checkpointPath: string,
  fallbackCreatedAt: string,
): Checkpoint {
  try {
    if (!fs.existsSync(checkpointPath)) {
      return { createdAt: fallbackCreatedAt, id: '00000000-0000-0000-0000-000000000000' };
    }
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (parsed?.createdAt && parsed?.id) {
      return { ...parsed, createdAt: String(parsed.createdAt), id: String(parsed.id) };
    }
  } catch {
    // fall through to default
  }
  return { createdAt: fallbackCreatedAt, id: '00000000-0000-0000-0000-000000000000' };
}

function saveBackfillCheckpoint(checkpointPath: string, checkpoint: Checkpoint): void {
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

module.exports = {
  loadBackfillCheckpoint,
  saveBackfillCheckpoint,
};
