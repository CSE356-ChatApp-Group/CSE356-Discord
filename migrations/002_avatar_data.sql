-- Add raw avatar storage columns so we can serve avatars without S3
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_data         BYTEA,
  ADD COLUMN IF NOT EXISTS avatar_content_type TEXT;
