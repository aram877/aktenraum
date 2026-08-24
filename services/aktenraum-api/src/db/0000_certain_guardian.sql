-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "alembic_version" (
	"version_num" varchar(32) PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_key" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "document_type_fields" (
	"paperless_doc_id" serial PRIMARY KEY NOT NULL,
	"document_type" varchar(64) NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"llm_model" varchar(128) DEFAULT 'qwen2.5:14b-instruct-q8_0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer_llm_model" varchar(128) DEFAULT 'qwen2.5:14b-instruct-q8_0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_approve_rules" (
	"document_type" varchar(64) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"min_confidence" numeric(3, 2) DEFAULT '0.90' NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" varchar(255)
);

*/