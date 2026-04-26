-- Drop synchronous member_count triggers.
-- member_count is now maintained via async Redis HINCRBY (community:counts)
-- with a periodic DB reconcile (communityMemberCount.ts).
DROP TRIGGER IF EXISTS trg_community_members_count_ins ON community_members;
DROP TRIGGER IF EXISTS trg_community_members_count_del ON community_members;
