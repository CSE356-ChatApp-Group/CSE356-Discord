-- Denormalized member_count on communities (maintained by triggers on community_members).
-- Removes expensive live COUNT(*) over all visible communities on GET /communities (no limit).

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS member_count INTEGER NOT NULL DEFAULT 0;

UPDATE communities c
SET member_count = COALESCE((
  SELECT COUNT(*)::int FROM community_members cm WHERE cm.community_id = c.id
), 0);

CREATE OR REPLACE FUNCTION trg_adjust_community_member_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE communities SET member_count = member_count + 1 WHERE id = NEW.community_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE communities
    SET member_count = GREATEST(0, member_count - 1)
    WHERE id = OLD.community_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_community_members_count_ins ON community_members;
CREATE TRIGGER trg_community_members_count_ins
  AFTER INSERT ON community_members
  FOR EACH ROW EXECUTE PROCEDURE trg_adjust_community_member_count();

DROP TRIGGER IF EXISTS trg_community_members_count_del ON community_members;
CREATE TRIGGER trg_community_members_count_del
  AFTER DELETE ON community_members
  FOR EACH ROW EXECUTE PROCEDURE trg_adjust_community_member_count();
