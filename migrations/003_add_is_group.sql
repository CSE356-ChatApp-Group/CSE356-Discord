ALTER TABLE conversations
  ADD COLUMN is_group BOOLEAN NOT NULL DEFAULT FALSE;

-- Back-fill: any conversation that ever had 3+ participants was always a group
UPDATE conversations c
SET    is_group = TRUE
WHERE  c.name IS NOT NULL
   OR  (SELECT COUNT(*) FROM conversation_participants
        WHERE conversation_id = c.id) >= 3;
