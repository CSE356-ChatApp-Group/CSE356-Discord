-- Replies reference a parent via thread_id. Hard-delete of the parent must not
-- fail with a foreign-key violation (prod showed DELETE /messages/:id → 500).
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_thread_id_fkey;

ALTER TABLE messages
  ADD CONSTRAINT messages_thread_id_fkey
  FOREIGN KEY (thread_id) REFERENCES messages (id) ON DELETE SET NULL;
