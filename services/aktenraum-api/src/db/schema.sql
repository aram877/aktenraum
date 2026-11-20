-- Idempotent schema bootstrap for the aktenraum database.
--
-- The DDL is the uncommented body of the drizzle-kit introspection in
-- 0000_certain_guardian.sql, which stays byte-identical to the generator's
-- output so it can serve as a drift oracle. This file is the runnable copy.
--
-- alembic_version is created and pinned to the Python API's head revision on
-- purpose: during the cutover's rollback window a redeployed Python API must
-- see an up-to-date database rather than replay every migration against
-- tables that already exist.

CREATE TABLE IF NOT EXISTS "alembic_version" (
	"version_num" varchar(32) PRIMARY KEY NOT NULL
);

CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_key" UNIQUE("username")
);

CREATE TABLE IF NOT EXISTS "document_type_fields" (
	"paperless_doc_id" serial PRIMARY KEY NOT NULL,
	"document_type" varchar(64) NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "app_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"llm_model" varchar(128) DEFAULT 'qwen2.5:14b-instruct-q8_0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer_llm_model" varchar(128) DEFAULT 'qwen2.5:14b-instruct-q8_0' NOT NULL
);

CREATE TABLE IF NOT EXISTS "auto_approve_rules" (
	"document_type" varchar(64) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"min_confidence" numeric(3, 2) DEFAULT '0.90' NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" varchar(255)
);

-- Paperless task ids of uploads made through aktenraum, so the import
-- activity page can tell uploads from e-mail (both carry a task owner).
CREATE TABLE IF NOT EXISTS "upload_tasks" (
	"task_id" varchar(64) PRIMARY KEY NOT NULL,
	"file_name" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Tenancy (ADR-009): one household, members (one per user), spaces ("Akten")
-- with their member lists, and exactly one home space per Paperless document.
-- paperless_user_id / paperless_group_id stay NULL until the Paperless mirror
-- (tenancy-foundation §3) provisions them; they live here because applySchema
-- can only create tables, never add columns.
CREATE TABLE IF NOT EXISTS "households" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "members" (
	"id" serial PRIMARY KEY NOT NULL,
	"household_id" integer NOT NULL REFERENCES "households"("id"),
	"user_id" integer NOT NULL REFERENCES "users"("id"),
	"role" varchar(16) NOT NULL,
	"paperless_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "members_paperless_user_id_key" UNIQUE("paperless_user_id"),
	CONSTRAINT "members_role_check" CHECK ("role" IN ('admin', 'member'))
);

CREATE TABLE IF NOT EXISTS "spaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"household_id" integer NOT NULL REFERENCES "households"("id"),
	"name" varchar(128) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"personal_member_id" integer REFERENCES "members"("id"),
	"paperless_group_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_personal_member_id_key" UNIQUE("personal_member_id"),
	CONSTRAINT "spaces_paperless_group_id_key" UNIQUE("paperless_group_id"),
	CONSTRAINT "spaces_kind_check" CHECK ("kind" IN ('personal', 'shared')),
	CONSTRAINT "spaces_personal_member_check" CHECK (("kind" = 'personal') = ("personal_member_id" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "space_members" (
	"space_id" integer NOT NULL REFERENCES "spaces"("id"),
	"member_id" integer NOT NULL REFERENCES "members"("id"),
	"role" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_pkey" PRIMARY KEY("space_id", "member_id"),
	CONSTRAINT "space_members_role_check" CHECK ("role" IN ('owner', 'editor', 'viewer'))
);

CREATE TABLE IF NOT EXISTS "document_spaces" (
	"paperless_doc_id" integer PRIMARY KEY NOT NULL,
	"space_id" integer NOT NULL REFERENCES "spaces"("id"),
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "document_spaces_space_id_idx" ON "document_spaces" ("space_id");

-- Who uploaded which Paperless task, so a new document's home space is the
-- uploader's personal space. paperless_doc_id is filled once the task has
-- finished: the new document's id, or 0 when it produced none (duplicate,
-- failure). A separate table because applySchema can't add a column to
-- upload_tasks. Same 30-day retention.
CREATE TABLE IF NOT EXISTS "upload_task_members" (
	"task_id" varchar(64) PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL REFERENCES "members"("id"),
	"paperless_doc_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Members' Paperless API tokens, AES-256-GCM under AKTENRAUM_SECRET_KEY
-- (ADR-010 §8). key_id identifies the key that encrypted the row, so a key
-- change is detected and the token simply re-minted.
CREATE TABLE IF NOT EXISTS "member_paperless_tokens" (
	"member_id" integer PRIMARY KEY NOT NULL REFERENCES "members"("id"),
	"ciphertext" text NOT NULL,
	"iv" varchar(32) NOT NULL,
	"auth_tag" varchar(32) NOT NULL,
	"key_id" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Invite links (ADR-009 / ADR-010): single use, 7 days, only the SHA-256 of
-- the secret token is stored.
CREATE TABLE IF NOT EXISTS "invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"household_id" integer NOT NULL REFERENCES "households"("id"),
	"role" varchar(16) DEFAULT 'member' NOT NULL,
	"created_by_member_id" integer NOT NULL REFERENCES "members"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_by_member_id" integer REFERENCES "members"("id"),
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invites_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "invites_role_check" CHECK ("role" IN ('admin', 'member'))
);

-- The viewer group of a shared space (tenancy-shared-spaces): `space-<id>-view`,
-- view-only on the space's documents. The writer group stays in
-- spaces.paperless_group_id; a separate table because applySchema can't add a
-- column to spaces.
CREATE TABLE IF NOT EXISTS "space_paperless_groups" (
	"space_id" integer PRIMARY KEY NOT NULL REFERENCES "spaces"("id"),
	"viewer_group_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_paperless_groups_viewer_group_id_key" UNIQUE("viewer_group_id")
);

-- The space an upload was sent into (the /upload picker). No row = the
-- uploader's personal space. Same 30-day retention as upload_task_members.
CREATE TABLE IF NOT EXISTS "upload_task_spaces" (
	"task_id" varchar(64) PRIMARY KEY NOT NULL,
	"space_id" integer NOT NULL REFERENCES "spaces"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Per-document shares (tenancy-document-shares, ADR-009): the owner of a
-- document's home space lends it to one other household member as viewer or
-- editor, optionally until expires_at. A revoke deletes the row; the history
-- lives in share_audit. "Active" is always decided in SQL
-- (expires_at IS NULL OR expires_at > now()).
CREATE TABLE IF NOT EXISTS "document_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"paperless_doc_id" integer NOT NULL,
	"member_id" integer NOT NULL REFERENCES "members"("id"),
	"role" varchar(16) NOT NULL,
	"expires_at" timestamp with time zone,
	"granted_by" integer NOT NULL REFERENCES "members"("id"),
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_shares_doc_member_key" UNIQUE("paperless_doc_id", "member_id"),
	CONSTRAINT "document_shares_role_check" CHECK ("role" IN ('viewer', 'editor'))
);

CREATE INDEX IF NOT EXISTS "document_shares_member_id_idx" ON "document_shares" ("member_id");

-- Grants, changes, revokes, expiries and recipients' accesses of shares.
-- actor_member_id is NULL for "expired". Accesses are deduplicated per
-- document, member and kind per hour by the writer.
CREATE TABLE IF NOT EXISTS "share_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"paperless_doc_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"actor_member_id" integer,
	"event" varchar(16) NOT NULL,
	"access_kind" varchar(16),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_audit_event_check" CHECK ("event" IN ('granted', 'role_changed', 'expiry_changed', 'revoked', 'expired', 'accessed')),
	CONSTRAINT "share_audit_access_kind_check" CHECK ("access_kind" IS NULL OR "access_kind" IN ('detail', 'preview', 'download', 'ask'))
);

CREATE INDEX IF NOT EXISTS "share_audit_doc_at_idx" ON "share_audit" ("paperless_doc_id", "at");

-- Member removal (tenancy-member-removal, ADR-009): a row here = the member is
-- removed. The member, user, personal space and audit history stay; every
-- member-facing lookup filters on this table. phase: 'db' (database changes
-- pending), 'derived' (Paperless + Qdrant pending), 'done'. A separate table
-- because applySchema can't add a column to members.
CREATE TABLE IF NOT EXISTS "member_removals" (
	"member_id" integer PRIMARY KEY NOT NULL REFERENCES "members"("id"),
	"successor_id" integer NOT NULL REFERENCES "members"("id"),
	"removed_by" integer NOT NULL REFERENCES "members"("id"),
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phase" varchar(16) DEFAULT 'db' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"completed_at" timestamp with time zone,
	CONSTRAINT "member_removals_phase_check" CHECK ("phase" IN ('db', 'derived', 'done')),
	CONSTRAINT "member_removals_successor_check" CHECK ("successor_id" <> "member_id")
);

-- Documents a removal must re-mirror (Paperless + Qdrant); synced_at marks
-- the ones already done so a resumed removal skips them. trashed = the
-- document was in the Paperless trash and is restored → mirrored → trashed
-- again; set before the restore so a resumed run puts it back in the trash.
CREATE TABLE IF NOT EXISTS "member_removal_documents" (
	"member_id" integer NOT NULL REFERENCES "member_removals"("member_id"),
	"paperless_doc_id" integer NOT NULL,
	"synced_at" timestamp with time zone,
	"trashed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "member_removal_documents_pkey" PRIMARY KEY("member_id", "paperless_doc_id")
);

INSERT INTO "alembic_version" ("version_num")
SELECT '0006'
WHERE NOT EXISTS (SELECT 1 FROM "alembic_version");
