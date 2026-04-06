-- Store avatars in object storage instead of BYTEA.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_storage_key TEXT UNIQUE;
