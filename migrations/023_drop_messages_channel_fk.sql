-- Drop messages.channel_id -> channels.id foreign key so channel message inserts
-- no longer perform FK validation against channels during INSERT/COMMIT.
--
-- Important: this also removes ON DELETE CASCADE cleanup for channel-backed
-- messages. Application-level cleanup must delete dependent message rows before
-- deleting channels or communities.

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_channel_id_fkey;
