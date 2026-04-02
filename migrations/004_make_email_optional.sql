-- Make email optional for user accounts.
-- Previously email was NOT NULL UNIQUE; now NULL is permitted so users can
-- register with username + password only.  The UNIQUE constraint is kept so
-- that two accounts cannot share the same non-null email address.
-- NULL values are intentionally excluded from unique-constraint checks in
-- PostgreSQL (each NULL is considered distinct), so this is safe.

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
