-- no-transaction
-- idx_read_states_user_target (user_id, COALESCE(channel_id, conversation_id)) already
-- covers every access pattern that idx_read_states_user_channel served. The partial index
-- had only 30 scans in the sample window vs 767k for the functional UNIQUE. Drop it to
-- reduce index maintenance cost on read_states upserts (each upsert maintained 4 indexes;
-- now 3) and to open the path for HOT updates on channel rows.
DROP INDEX CONCURRENTLY IF EXISTS idx_read_states_user_channel;
