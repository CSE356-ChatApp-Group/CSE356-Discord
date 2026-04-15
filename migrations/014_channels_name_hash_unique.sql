-- Prevent index tuple overflow for very long channel names while preserving
-- per-community uniqueness semantics.
--
-- The previous UNIQUE (community_id, name) btree can fail with:
--   "index row requires ... bytes, maximum size is 8191"
-- when name is very long. We move uniqueness to a stable hash key.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS name_hash BYTEA
  GENERATED ALWAYS AS (digest(name, 'sha256')) STORED;

-- Drop the wide-text unique constraint that can overflow btree tuple limits.
ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_community_id_name_key;

-- Enforce uniqueness with a bounded key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_community_name_hash_unique
  ON channels (community_id, name_hash);
