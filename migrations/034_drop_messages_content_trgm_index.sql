-- no-transaction
-- Migration 034: Drop unused messages.content trigram GIN index.
-- Runtime search uses content_tsv FTS + bounded position(lower()) literal fallback;
-- idx_messages_content_trgm is no longer used and adds write amplification.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_messages_content_trgm;
