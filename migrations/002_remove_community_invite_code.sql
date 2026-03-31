-- Remove obsolete invite link/code mechanism for communities.
ALTER TABLE communities
  DROP COLUMN IF EXISTS invite_code;
