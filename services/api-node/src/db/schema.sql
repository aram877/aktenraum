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

INSERT INTO "alembic_version" ("version_num")
SELECT '0006'
WHERE NOT EXISTS (SELECT 1 FROM "alembic_version");
