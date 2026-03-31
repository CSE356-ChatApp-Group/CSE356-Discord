-- =============================================================================
-- ChatApp MVP - Initial Schema
-- =============================================================================
-- Design principles:
--   • UUIDs as primary keys (cloud-safe, no sequence contention across nodes)
--   • soft-delete via deleted_at on messages (audit trail + edit history)
--   • read_states use composite PK for efficient per-user cursors
--   • Indexes tuned for the most frequent query patterns
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram search on message content

-- ---------------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT,                         -- NULL for pure OAuth users
    display_name  TEXT NOT NULL,
    avatar_url    TEXT,
    bio           TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_users_email    ON users (email);
CREATE INDEX idx_users_username ON users (username);

-- ---------------------------------------------------------------------------
-- OAUTH PROVIDERS
-- ---------------------------------------------------------------------------
CREATE TABLE oauth_accounts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,   -- 'google' | 'github' | 'oidc'
    provider_id TEXT NOT NULL,   -- subject claim from provider
    email       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_id)
);

CREATE INDEX idx_oauth_user ON oauth_accounts (user_id);

-- ---------------------------------------------------------------------------
-- COMMUNITIES  (like Discord "servers")
-- ---------------------------------------------------------------------------
CREATE TABLE communities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT NOT NULL UNIQUE,           -- URL-safe name
    name        TEXT NOT NULL,
    description TEXT,
    icon_url    TEXT,
    owner_id    UUID NOT NULL REFERENCES users (id),
    is_public   BOOLEAN NOT NULL DEFAULT TRUE,
    invite_code TEXT UNIQUE,                    -- joinable via code
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_communities_owner ON communities (owner_id);
CREATE INDEX idx_communities_slug  ON communities (slug);

-- ---------------------------------------------------------------------------
-- COMMUNITY MEMBERS
-- ---------------------------------------------------------------------------
CREATE TYPE community_role AS ENUM ('owner', 'admin', 'moderator', 'member');

CREATE TABLE community_members (
    community_id UUID NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role         community_role NOT NULL DEFAULT 'member',
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    muted_until  TIMESTAMPTZ,
    PRIMARY KEY (community_id, user_id)
);

CREATE INDEX idx_cm_user ON community_members (user_id);

-- ---------------------------------------------------------------------------
-- CHANNELS  (within a community)
-- ---------------------------------------------------------------------------
CREATE TYPE channel_type AS ENUM ('text', 'announcement', 'voice_placeholder');

CREATE TABLE channels (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id UUID NOT NULL REFERENCES communities (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    is_private   BOOLEAN NOT NULL DEFAULT FALSE,
    type         channel_type NOT NULL DEFAULT 'text',
    position     INTEGER NOT NULL DEFAULT 0,    -- display ordering
    created_by   UUID REFERENCES users (id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (community_id, name)
);

CREATE INDEX idx_channels_community ON channels (community_id, position);

-- Private channel access-list
CREATE TABLE channel_members (
    channel_id UUID NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

-- ---------------------------------------------------------------------------
-- DIRECT CONVERSATIONS  (1:1 and small groups, no community required)
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT,                             -- NULL for 1:1, set for groups
    created_by UUID NOT NULL REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_participants (
    conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at         TIMESTAMPTZ,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX idx_cp_user ON conversation_participants (user_id);

-- ---------------------------------------------------------------------------
-- MESSAGES
-- Polymorphic: belongs to EITHER a channel OR a conversation (not both).
-- ---------------------------------------------------------------------------
CREATE TYPE message_type AS ENUM ('text', 'system', 'attachment');

CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- exactly one of these two must be set (enforced by CHECK below)
    channel_id      UUID REFERENCES channels (id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations (id) ON DELETE CASCADE,
    author_id       UUID NOT NULL REFERENCES users (id),
    content         TEXT,
    type            message_type NOT NULL DEFAULT 'text',
    -- threading (optional, for replies)
    thread_id       UUID REFERENCES messages (id),
    -- edit / delete tracking
    edited_at       TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,                 -- soft delete
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT messages_target_xor CHECK (
        (channel_id IS NOT NULL)::INT + (conversation_id IS NOT NULL)::INT = 1
    )
);

CREATE INDEX idx_messages_channel  ON messages (channel_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_conv     ON messages (conversation_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_author   ON messages (author_id);
CREATE INDEX idx_messages_thread   ON messages (thread_id) WHERE thread_id IS NOT NULL;
-- Full-text search using pg_trgm (supplement to Meilisearch for simple queries)
CREATE INDEX idx_messages_content_trgm ON messages USING GIN (content gin_trgm_ops) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- ATTACHMENTS  (up to 4 per message, stored in S3-compatible bucket)
-- ---------------------------------------------------------------------------
CREATE TYPE attachment_type AS ENUM ('image', 'file');

CREATE TABLE attachments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id   UUID NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    uploader_id  UUID NOT NULL REFERENCES users (id),
    type         attachment_type NOT NULL DEFAULT 'image',
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes   BIGINT NOT NULL,
    storage_key  TEXT NOT NULL UNIQUE,           -- S3 object key
    width        INTEGER,                        -- pixels (images only)
    height       INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_attachments_message ON attachments (message_id);

-- ---------------------------------------------------------------------------
-- READ STATES  (tracks last-read position per user per channel/conversation)
-- ---------------------------------------------------------------------------
CREATE TABLE read_states (
    user_id              UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- target: channel XOR conversation
    channel_id           UUID REFERENCES channels (id) ON DELETE CASCADE,
    conversation_id      UUID REFERENCES conversations (id) ON DELETE CASCADE,
    last_read_message_id UUID REFERENCES messages (id) ON DELETE SET NULL,
    last_read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT read_states_target_xor CHECK (
        (channel_id IS NOT NULL)::INT + (conversation_id IS NOT NULL)::INT = 1
    )
);

CREATE UNIQUE INDEX idx_read_states_user_target
    ON read_states (user_id, COALESCE(channel_id, conversation_id));

CREATE INDEX idx_read_states_channel ON read_states (channel_id, user_id);
CREATE INDEX idx_read_states_conv    ON read_states (conversation_id, user_id);

-- ---------------------------------------------------------------------------
-- PRESENCE  (stored in Redis primarily, but mirrored here for persistence)
-- ---------------------------------------------------------------------------
CREATE TYPE presence_status AS ENUM ('online', 'idle', 'away', 'offline');

CREATE TABLE presence_snapshots (
    user_id    UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    status     presence_status NOT NULL DEFAULT 'offline',
    custom_msg TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- HELPER: auto-update updated_at on row changes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DO $$
DECLARE tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['users','communities','channels','conversations','messages'] LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()', tbl, tbl);
    END LOOP;
END;
$$;
