CREATE TABLE IF NOT EXISTS dm_conversation_pairs (
  conversation_id UUID PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  user_low        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_high       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dm_conversation_pairs_distinct_users CHECK (user_low <> user_high),
  CONSTRAINT dm_conversation_pairs_ordered_users CHECK (user_low < user_high),
  CONSTRAINT dm_conversation_pairs_user_pair_unique UNIQUE (user_low, user_high)
);

CREATE OR REPLACE FUNCTION refresh_dm_conversation_pair(p_conversation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  conv_is_group BOOLEAN;
  conv_name TEXT;
  active_count INTEGER;
  active_user_ids UUID[];
  low_id UUID;
  high_id UUID;
BEGIN
  SELECT is_group, name
    INTO conv_is_group, conv_name
  FROM conversations
  WHERE id = p_conversation_id;

  IF NOT FOUND THEN
    DELETE FROM dm_conversation_pairs WHERE conversation_id = p_conversation_id;
    RETURN;
  END IF;

  IF conv_is_group OR conv_name IS NOT NULL THEN
    DELETE FROM dm_conversation_pairs WHERE conversation_id = p_conversation_id;
    RETURN;
  END IF;

  SELECT COUNT(*)::INTEGER,
         ARRAY_AGG(user_id ORDER BY user_id)
    INTO active_count, active_user_ids
  FROM conversation_participants
  WHERE conversation_id = p_conversation_id
    AND left_at IS NULL;

  low_id := active_user_ids[1];
  high_id := active_user_ids[2];

  IF active_count = 2 AND low_id IS NOT NULL AND high_id IS NOT NULL AND low_id <> high_id THEN
    INSERT INTO dm_conversation_pairs (conversation_id, user_low, user_high, updated_at)
    VALUES (p_conversation_id, low_id, high_id, NOW())
    ON CONFLICT (conversation_id)
    DO UPDATE
      SET user_low = EXCLUDED.user_low,
          user_high = EXCLUDED.user_high,
          updated_at = NOW();
  ELSE
    DELETE FROM dm_conversation_pairs WHERE conversation_id = p_conversation_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION trg_refresh_dm_conversation_pair()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM refresh_dm_conversation_pair(COALESCE(NEW.conversation_id, OLD.conversation_id));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS conversation_participants_refresh_dm_pair ON conversation_participants;
CREATE TRIGGER conversation_participants_refresh_dm_pair
AFTER INSERT OR UPDATE OF user_id, left_at OR DELETE
ON conversation_participants
FOR EACH ROW
EXECUTE FUNCTION trg_refresh_dm_conversation_pair();

DROP TRIGGER IF EXISTS conversations_refresh_dm_pair ON conversations;
CREATE TRIGGER conversations_refresh_dm_pair
AFTER UPDATE OF is_group, name
ON conversations
FOR EACH ROW
EXECUTE FUNCTION trg_refresh_dm_conversation_pair();

DELETE FROM dm_conversation_pairs;

WITH pair_candidates AS (
  SELECT c.id AS conversation_id,
         (ARRAY_AGG(cp.user_id ORDER BY cp.user_id))[1] AS user_low,
         (ARRAY_AGG(cp.user_id ORDER BY cp.user_id))[2] AS user_high,
         COALESCE(c.last_message_at, c.updated_at, c.created_at) AS activity_at,
         c.created_at
  FROM conversations c
  JOIN conversation_participants cp
    ON cp.conversation_id = c.id
   AND cp.left_at IS NULL
  WHERE c.is_group = FALSE
    AND c.name IS NULL
  GROUP BY c.id, c.last_message_at, c.updated_at, c.created_at
  HAVING COUNT(*) = 2
     AND (ARRAY_AGG(cp.user_id ORDER BY cp.user_id))[1]
         <> (ARRAY_AGG(cp.user_id ORDER BY cp.user_id))[2]
),
ranked_pairs AS (
  SELECT conversation_id,
         user_low,
         user_high,
         ROW_NUMBER() OVER (
           PARTITION BY user_low, user_high
           ORDER BY activity_at DESC, created_at DESC, conversation_id DESC
         ) AS rn
  FROM pair_candidates
)
INSERT INTO dm_conversation_pairs (conversation_id, user_low, user_high, updated_at)
SELECT conversation_id, user_low, user_high, NOW()
FROM ranked_pairs
WHERE rn = 1
ON CONFLICT (conversation_id)
DO UPDATE
  SET user_low = EXCLUDED.user_low,
      user_high = EXCLUDED.user_high,
      updated_at = NOW();
