import { pgTable, varchar, unique, serial, timestamp, jsonb, boolean, numeric, integer, primaryKey, check, index, text, bigserial } from "drizzle-orm/pg-core"
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

export const memberPaperlessTokens = pgTable("member_paperless_tokens", {
	memberId: integer("member_id").primaryKey().notNull().references(() => members.id),
	ciphertext: text().notNull(),
	iv: varchar({ length: 32 }).notNull(),
	authTag: varchar("auth_tag", { length: 32 }).notNull(),
	keyId: varchar("key_id", { length: 16 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const invites = pgTable("invites", {
	id: serial().primaryKey().notNull(),
	tokenHash: varchar("token_hash", { length: 64 }).notNull(),
	householdId: integer("household_id").notNull().references(() => households.id),
	role: varchar({ length: 16 }).$type<HouseholdRoleValue>().default("member").notNull(),
	createdByMemberId: integer("created_by_member_id").notNull().references(() => members.id),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	redeemedAt: timestamp("redeemed_at", { withTimezone: true, mode: 'string' }),
	redeemedByMemberId: integer("redeemed_by_member_id").references(() => members.id),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	unique("invites_token_hash_key").on(table.tokenHash),
	check("invites_role_check", sql`${table.role} IN ('admin', 'member')`),
]);

/** 0 in paperless_doc_id = the task finished without creating a document. */
export const uploadTaskMembers = pgTable("upload_task_members", {
	taskId: varchar("task_id", { length: 64 }).primaryKey().notNull(),
	memberId: integer("member_id").notNull().references(() => members.id),
	paperlessDocId: integer("paperless_doc_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

/** The viewer group of a shared space (`space-<id>-view`); the writer group id lives in `spaces`. */
export const spacePaperlessGroups = pgTable("space_paperless_groups", {
	spaceId: integer("space_id").primaryKey().notNull().references(() => spaces.id),
	viewerGroupId: integer("viewer_group_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("space_paperless_groups_viewer_group_id_key").on(table.viewerGroupId),
]);

/** The space an aktenraum upload was sent into (absent = the uploader's personal space). */
export const uploadTaskSpaces = pgTable("upload_task_spaces", {
	taskId: varchar("task_id", { length: 64 }).primaryKey().notNull(),
	spaceId: integer("space_id").notNull().references(() => spaces.id),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export type ShareRole = "viewer" | "editor";
export type ShareAuditEvent = "granted" | "role_changed" | "expiry_changed" | "revoked" | "expired" | "accessed";
export type ShareAccessKindValue = "detail" | "preview" | "download" | "ask";

/** Per-document shares (ADR-009). Active = `expires_at IS NULL OR expires_at > now()`, evaluated in SQL. */
export const documentShares = pgTable("document_shares", {
	id: serial().primaryKey().notNull(),
	paperlessDocId: integer("paperless_doc_id").notNull(),
	memberId: integer("member_id").notNull().references(() => members.id),
	role: varchar({ length: 16 }).$type<ShareRole>().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	grantedBy: integer("granted_by").notNull().references(() => members.id),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("document_shares_doc_member_key").on(table.paperlessDocId, table.memberId),
	check("document_shares_role_check", sql`${table.role} IN ('viewer', 'editor')`),
	index("document_shares_member_id_idx").on(table.memberId),
]);

export const shareAudit = pgTable("share_audit", {
	id: bigserial({ mode: "number" }).primaryKey().notNull(),
	paperlessDocId: integer("paperless_doc_id").notNull(),
	memberId: integer("member_id").notNull(),
	actorMemberId: integer("actor_member_id"),
	event: varchar({ length: 16 }).$type<ShareAuditEvent>().notNull(),
	accessKind: varchar("access_kind", { length: 16 }).$type<ShareAccessKindValue>(),
	at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("share_audit_event_check", sql`${table.event} IN ('granted', 'role_changed', 'expiry_changed', 'revoked', 'expired', 'accessed')`),
	check("share_audit_access_kind_check", sql`${table.accessKind} IS NULL OR ${table.accessKind} IN ('detail', 'preview', 'download', 'ask')`),
	index("share_audit_doc_at_idx").on(table.paperlessDocId, table.at),
]);
