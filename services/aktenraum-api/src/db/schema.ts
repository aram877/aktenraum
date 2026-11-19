import { pgTable, varchar, unique, serial, timestamp, jsonb, boolean, numeric, integer, primaryKey, check, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const alembicVersion = pgTable("alembic_version", {
	versionNum: varchar("version_num", { length: 32 }).primaryKey().notNull(),
});

export const users = pgTable("users", {
	id: serial().primaryKey().notNull(),
	username: varchar({ length: 64 }).notNull(),
	passwordHash: varchar("password_hash", { length: 255 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("users_username_key").on(table.username),
]);

export const documentTypeFields = pgTable("document_type_fields", {
	paperlessDocId: serial("paperless_doc_id").primaryKey().notNull(),
	documentType: varchar("document_type", { length: 64 }).notNull(),
	fields: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const appSettings = pgTable("app_settings", {
	id: serial().primaryKey().notNull(),
	llmModel: varchar("llm_model", { length: 128 }).default('qwen2.5:14b-instruct-q8_0').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	answerLlmModel: varchar("answer_llm_model", { length: 128 }).default('qwen2.5:14b-instruct-q8_0').notNull(),
});

export const autoApproveRules = pgTable("auto_approve_rules", {
	documentType: varchar("document_type", { length: 64 }).primaryKey().notNull(),
	enabled: boolean().default(false).notNull(),
	minConfidence: numeric("min_confidence", { precision: 3, scale:  2 }).default('0.90').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	updatedBy: varchar("updated_by", { length: 255 }),
});

export const uploadTasks = pgTable("upload_tasks", {
	taskId: varchar("task_id", { length: 64 }).primaryKey().notNull(),
	fileName: varchar("file_name", { length: 255 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

// Tenancy (ADR-009). Mirrors the hand-written DDL in schema.sql.

export const households = pgTable("households", {
	id: serial().primaryKey().notNull(),
	name: varchar({ length: 128 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export type HouseholdRoleValue = "admin" | "member";
export type SpaceKind = "personal" | "shared";
export type SpaceRole = "owner" | "editor" | "viewer";

export const members = pgTable("members", {
	id: serial().primaryKey().notNull(),
	householdId: integer("household_id").notNull().references(() => households.id),
	userId: integer("user_id").notNull().references(() => users.id),
	role: varchar({ length: 16 }).$type<HouseholdRoleValue>().notNull(),
	paperlessUserId: integer("paperless_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("members_user_id_key").on(table.userId),
	unique("members_paperless_user_id_key").on(table.paperlessUserId),
	check("members_role_check", sql`${table.role} IN ('admin', 'member')`),
]);

export const spaces = pgTable("spaces", {
	id: serial().primaryKey().notNull(),
	householdId: integer("household_id").notNull().references(() => households.id),
	name: varchar({ length: 128 }).notNull(),
	kind: varchar({ length: 16 }).$type<SpaceKind>().notNull(),
	personalMemberId: integer("personal_member_id").references(() => members.id),
	paperlessGroupId: integer("paperless_group_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("spaces_personal_member_id_key").on(table.personalMemberId),
	unique("spaces_paperless_group_id_key").on(table.paperlessGroupId),
	check("spaces_kind_check", sql`${table.kind} IN ('personal', 'shared')`),
	check("spaces_personal_member_check", sql`(${table.kind} = 'personal') = (${table.personalMemberId} IS NOT NULL)`),
]);

export const spaceMembers = pgTable("space_members", {
	spaceId: integer("space_id").notNull().references(() => spaces.id),
	memberId: integer("member_id").notNull().references(() => members.id),
	role: varchar({ length: 16 }).$type<SpaceRole>().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ name: "space_members_pkey", columns: [table.spaceId, table.memberId] }),
	check("space_members_role_check", sql`${table.role} IN ('owner', 'editor', 'viewer')`),
]);

export const documentSpaces = pgTable("document_spaces", {
	paperlessDocId: integer("paperless_doc_id").primaryKey().notNull(),
	spaceId: integer("space_id").notNull().references(() => spaces.id),
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("document_spaces_space_id_idx").on(table.spaceId),
]);

/** 0 in paperless_doc_id = the task finished without creating a document. */
export const uploadTaskMembers = pgTable("upload_task_members", {
	taskId: varchar("task_id", { length: 64 }).primaryKey().notNull(),
	memberId: integer("member_id").notNull().references(() => members.id),
	paperlessDocId: integer("paperless_doc_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});
