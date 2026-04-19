-- Migration 019: add last_read_message_created_at to read_states
--
-- The advanceReadStateCursor upsert's DO UPDATE WHERE clause previously did:
--   NOT EXISTS (SELECT 1 FROM messages WHERE id = last_read_message_id AND created_at > $5)
-- This cross-table subquery costs ~5-15ms per call against an 8M+ row messages table
-- with a cold buffer pool, causing p95 latency regression under mark-read load.
--
-- Storing the message's created_at directly in read_states lets the WHERE clause
-- use a plain column comparison: $new_created_at >= last_read_message_created_at
-- No messages table join required.
--
-- The column is nullable: NULL means "no prior read state" which maps to
-- the existing IS NULL branch, so no backfill is needed.

ALTER TABLE read_states
  ADD COLUMN IF NOT EXISTS last_read_message_created_at TIMESTAMPTZ;
