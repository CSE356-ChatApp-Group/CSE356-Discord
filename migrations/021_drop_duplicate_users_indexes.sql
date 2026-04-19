-- Drop duplicate indexes on the users table.
--
-- The unique constraints users_username_key and users_email_key (created by
-- UNIQUE column declarations) are functionally identical to the explicit indexes
-- idx_users_username and idx_users_email. Keeping both doubles the index write
-- cost on every INSERT and wastes ~176 MB of shared_buffers.
--
-- PostgreSQL enforces uniqueness via the constraint indexes; the explicit
-- duplicate indexes add no query-planning value.

DROP INDEX IF EXISTS idx_users_username;
DROP INDEX IF EXISTS idx_users_email;
