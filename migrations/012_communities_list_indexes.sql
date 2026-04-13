-- Communities list path hot indexes.
-- Helps:
--   - WHERE c.is_public = TRUE ORDER BY c.name, c.id
--   - Keyset pagination on (name, id)
--   - Join/filter on community_members(user_id, community_id)

CREATE INDEX IF NOT EXISTS idx_communities_public_name_id
  ON communities (is_public, name, id);

CREATE INDEX IF NOT EXISTS idx_community_members_user_community
  ON community_members (user_id, community_id);
