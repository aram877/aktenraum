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

INSERT INTO "alembic_version" ("version_num")
SELECT '0006'
WHERE NOT EXISTS (SELECT 1 FROM "alembic_version");
