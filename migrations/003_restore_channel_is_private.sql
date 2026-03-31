-- Backfill schema drift where channels.is_private may be missing.
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;
