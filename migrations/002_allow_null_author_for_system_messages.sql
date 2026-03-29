-- Allow NULL author_id for system messages
-- System messages have type='system' and author_id=NULL

ALTER TABLE messages
ALTER COLUMN author_id DROP NOT NULL;

-- Add constraint to ensure either author_id is NOT NULL (regular message)
-- or type is 'system' (system message has no author)
ALTER TABLE messages
ADD CONSTRAINT messages_author_consistency CHECK (
    (author_id IS NOT NULL AND type != 'system') OR
    (author_id IS NULL AND type = 'system')
);
