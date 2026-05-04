-- Migration 038: Keep messages visibility map fresh via autovacuum insert threshold.
--
-- Problem: messages is an insert-heavy table with very few dead tuples (<0.1%).
-- Autovacuum's dead-tuple threshold (scale_factor=0.2 × 33M rows = 6.7M dead needed)
-- is never reached, so autovacuum never runs, the visibility map is never updated,
-- and idx_messages_channel index-only scans degrade to 116K+ heap fetches per FTS
-- candidate query on large communities. Cold query time: 382ms; under production
-- load with cache pressure: 1600ms+, causing statement_timeout 500s.
--
-- Fix: lower autovacuum insert threshold so autovacuum runs periodically
-- to keep the visibility map current even without dead tuple accumulation.
--   autovacuum_vacuum_insert_scale_factor=0.02 → trigger after 2% of live rows
--   inserted (~675K new messages at current size), i.e. roughly every few days.
--   autovacuum_vacuum_insert_threshold=5000 → minimum floor.
ALTER TABLE messages SET (
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold    = 5000
);
