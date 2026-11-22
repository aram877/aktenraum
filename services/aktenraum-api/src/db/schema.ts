import { pgTable, varchar, unique, serial, timestamp, jsonb, boolean, numeric, integer, primaryKey, check, index, text, bigserial, bigint } from "drizzle-orm/pg-core"
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

export type MemberRemovalPhase = "db" | "derived" | "done";

/** A row = the member is removed (tenancy-member-removal). Never deleted. */
export const memberRemovals = pgTable("member_removals", {
	memberId: integer("member_id").primaryKey().notNull().references(() => members.id),
	successorId: integer("successor_id").notNull().references(() => members.id),
	removedBy: integer("removed_by").notNull().references(() => members.id),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	phase: varchar({ length: 16 }).$type<MemberRemovalPhase>().default("db").notNull(),
	attempts: integer().default(0).notNull(),
	lastError: text("last_error"),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	check("member_removals_phase_check", sql`${table.phase} IN ('db', 'derived', 'done')`),
	check("member_removals_successor_check", sql`${table.successorId} <> ${table.memberId}`),
]);

/** Documents a removal re-mirrors; `synced_at` set once Paperless + Qdrant follow. */
export const memberRemovalDocuments = pgTable("member_removal_documents", {
	memberId: integer("member_id").notNull().references(() => memberRemovals.memberId),
	paperlessDocId: integer("paperless_doc_id").notNull(),
	syncedAt: timestamp("synced_at", { withTimezone: true, mode: 'string' }),
	/** In the Paperless trash: restored → mirrored → trashed again (set before the restore). */
	trashed: boolean().default(false).notNull(),
}, (table) => [
	primaryKey({ name: "member_removal_documents_pkey", columns: [table.memberId, table.paperlessDocId] }),
]);

// ---------------------------------------------------------------------------
// Authentication (auth-server-sessions, ADR-010 step 4). The value lists
// already include what auth-passkeys adds, because applySchema can't widen a
// CHECK or add a column later.
// ---------------------------------------------------------------------------

export type SessionAuthMethod = "password" | "invite" | "passkey" | "recovery" | "setup";
export type SessionRevokedReason = "logout" | "user" | "other_device" | "password_change" | "member_removed";

/** Server-side browser sessions. The cookie holds a random token; only its sha256 hex is stored. */
export const sessions = pgTable("sessions", {
	id: bigserial({ mode: "number" }).primaryKey().notNull(),
	tokenHash: varchar("token_hash", { length: 64 }).notNull(),
	memberId: integer("member_id").notNull().references(() => members.id),
	householdId: integer("household_id").notNull().references(() => households.id),
	clientId: varchar("client_id", { length: 32 }).default("spa").notNull(),
	authMethod: varchar("auth_method", { length: 16 }).$type<SessionAuthMethod>().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	/** auth-passkeys: time of the last step-up confirmation. */
	stepUpAt: timestamp("step_up_at", { withTimezone: true, mode: 'string' }),
	userAgent: varchar("user_agent", { length: 512 }),
	ip: varchar({ length: 64 }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	revokedReason: varchar("revoked_reason", { length: 32 }).$type<SessionRevokedReason>(),
}, (table) => [
	unique("sessions_token_hash_key").on(table.tokenHash),
	check("sessions_auth_method_check", sql`${table.authMethod} IN ('password', 'invite', 'passkey', 'recovery', 'setup')`),
	check("sessions_revoked_reason_check", sql`${table.revokedReason} IS NULL OR ${table.revokedReason} IN ('logout', 'user', 'other_device', 'password_change', 'member_removed')`),
	index("sessions_member_id_idx").on(table.memberId),
]);

/** One row per failed login / invite attempt; the window is counted in SQL. */
export const authRateLimitEvents = pgTable("auth_rate_limit_events", {
	id: bigserial({ mode: "number" }).primaryKey().notNull(),
	key: varchar({ length: 160 }).notNull(),
	at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("auth_rate_limit_events_key_at_idx").on(table.key, table.at),
]);

export type AuthAuditEvent =
	| "login_succeeded"
	| "login_failed"
	| "login_throttled"
	| "logout"
	| "session_revoked"
	| "password_changed"
	| "invite_redeemed";

/** Authentication events, kept 180 days. No foreign keys: it outlives what it mentions. */
export const authAudit = pgTable("auth_audit", {
	id: bigserial({ mode: "number" }).primaryKey().notNull(),
	at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	event: varchar({ length: 32 }).$type<AuthAuditEvent>().notNull(),
	memberId: integer("member_id"),
	actorMemberId: integer("actor_member_id"),
	sessionId: bigint("session_id", { mode: "number" }),
	username: varchar({ length: 64 }),
	reason: varchar({ length: 32 }),
	ip: varchar({ length: 64 }),
	userAgent: varchar("user_agent", { length: 512 }),
}, (table) => [
	check("auth_audit_event_check", sql`${table.event} IN ('login_succeeded', 'login_failed', 'login_throttled', 'logout', 'session_revoked', 'password_changed', 'invite_redeemed')`),
	index("auth_audit_at_idx").on(table.at),
]);

// ---------------------------------------------------------------------------
// Passkeys, recovery and step-up (auth-passkeys, ADR-010 step 4).
// ---------------------------------------------------------------------------

/** One random WebAuthn user handle per member (base64url of 64 bytes). */
export const webauthnUsers = pgTable("webauthn_users", {
	memberId: integer("member_id").primaryKey().notNull().references(() => members.id),
	userHandle: varchar("user_handle", { length: 86 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("webauthn_users_user_handle_key").on(table.userHandle),
]);

export type PasskeyDeviceType = "singleDevice" | "multiDevice";

export const passkeys = pgTable("passkeys", {
	id: serial().primaryKey().notNull(),
	memberId: integer("member_id").notNull().references(() => members.id),
	credentialId: varchar("credential_id", { length: 1366 }).notNull(),
	publicKey: text("public_key").notNull(),
	signCount: bigint("sign_count", { mode: "number" }).default(0).notNull(),
	transports: varchar({ length: 128 }),
	aaguid: varchar({ length: 36 }),
	deviceType: varchar("device_type", { length: 16 }).$type<PasskeyDeviceType>().notNull(),
	backedUp: boolean("backed_up").notNull(),
	prfEnabled: boolean("prf_enabled").default(false).notNull(),
	rpId: varchar("rp_id", { length: 253 }).notNull(),
	name: varchar({ length: 64 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	unique("passkeys_credential_id_key").on(table.credentialId),
	check("passkeys_device_type_check", sql`${table.deviceType} IN ('singleDevice', 'multiDevice')`),
	index("passkeys_member_id_idx").on(table.memberId),
]);

export type WebauthnCeremonyKind = "register" | "login" | "step_up";
export type WebauthnPurpose = "enrol" | "add" | "invite" | "setup" | "login" | "step_up";

/** A begun WebAuthn ceremony: 5 minutes, claimed exactly once. */
export const webauthnChallenges = pgTable("webauthn_challenges", {
	id: bigserial({ mode: "number" }).primaryKey().notNull(),
	ceremony: varchar({ length: 43 }).notNull(),
	challenge: varchar({ length: 128 }).notNull(),
	kind: varchar({ length: 16 }).$type<WebauthnCeremonyKind>().notNull(),
	purpose: varchar({ length: 16 }).$type<WebauthnPurpose>().notNull(),
	memberId: integer("member_id"),
	sessionId: bigint("session_id", { mode: "number" }),
	inviteId: integer("invite_id"),
	setupTokenId: integer("setup_token_id"),
	username: varchar({ length: 64 }),
	userHandle: varchar("user_handle", { length: 86 }),
	rpId: varchar("rp_id", { length: 253 }).notNull(),
	origin: varchar({ length: 255 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	unique("webauthn_challenges_ceremony_key").on(table.ceremony),
]);

/** sha256 hex of the normalised code; never the code itself. */
export const recoveryCodes = pgTable("recovery_codes", {
	id: serial().primaryKey().notNull(),
	memberId: integer("member_id").notNull().references(() => members.id),
	batchId: varchar("batch_id", { length: 32 }).notNull(),
	codeHash: varchar("code_hash", { length: 64 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
	invalidatedAt: timestamp("invalidated_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	unique("recovery_codes_code_hash_key").on(table.codeHash),
	index("recovery_codes_member_id_idx").on(table.memberId),
]);

/** Single-use setup links; created_by_member_id NULL = host CLI / first run. */
export const setupTokens = pgTable("setup_tokens", {
	id: serial().primaryKey().notNull(),
	tokenHash: varchar("token_hash", { length: 64 }).notNull(),
	memberId: integer("member_id").notNull().references(() => members.id),
	createdByMemberId: integer("created_by_member_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	unique("setup_tokens_token_hash_key").on(table.tokenHash),
]);

/** A row = password login is off for the member; the hash stays for a rollback. */
export const passwordRetirements = pgTable("password_retirements", {
	memberId: integer("member_id").primaryKey().notNull().references(() => members.id),
	retiredAt: timestamp("retired_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sessionId: bigint("session_id", { mode: "number" }),
});

export type CredentialAuditEvent =
	| "passkey_added"
	| "passkey_renamed"
	| "passkey_removed"
	| "recovery_codes_generated"
	| "recovery_code_used"
	| "setup_link_created"
	| "setup_link_used"
	| "password_retired"
	| "step_up_succeeded"
	| "step_up_failed"
	| "token_created"
	| "token_revoked"
	| "token_rejected_expired";

/** Credential events, kept 180 days. No CHECK on event, no foreign keys. */
export const credentialAudit = pgTable("credential_audit", {
	id: bigserial({ mode: "number" }).primaryKey().notNull(),
	at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	event: varchar({ length: 32 }).$type<CredentialAuditEvent>().notNull(),
	memberId: integer("member_id"),
	actorMemberId: integer("actor_member_id"),
	sessionId: bigint("session_id", { mode: "number" }),
	passkeyId: integer("passkey_id"),
	detail: varchar({ length: 128 }),
	ip: varchar({ length: 64 }),
	userAgent: varchar("user_agent", { length: 512 }),
}, (table) => [
	index("credential_audit_at_idx").on(table.at),
]);

// ---------------------------------------------------------------------------
// Personal access tokens (personal-access-tokens, ADR-010 step 6).
// ---------------------------------------------------------------------------

export type TokenRevokedReason = "user" | "member_removed";

/**
 * A member's bearer tokens for scripts. Only the sha256 hex of the value is
 * stored; `display_prefix` (first 12 characters) lets the member recognise it.
 * `scopes` is a comma list, validated against TOKEN_SCOPES on write and read.
 * Active = `revoked_at IS NULL AND expires_at > now()`.
 */
export const personalAccessTokens = pgTable("personal_access_tokens", {
	id: serial().primaryKey().notNull(),
	memberId: integer("member_id").notNull().references(() => members.id),
	householdId: integer("household_id").notNull().references(() => households.id),
	name: varchar({ length: 64 }).notNull(),
	tokenHash: varchar("token_hash", { length: 64 }).notNull(),
	displayPrefix: varchar("display_prefix", { length: 16 }).notNull(),
	scopes: varchar({ length: 256 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	lastUsedIp: varchar("last_used_ip", { length: 64 }),
	/** Last `token_rejected_expired` audit write (at most hourly). */
	expiredAuditAt: timestamp("expired_audit_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	revokedReason: varchar("revoked_reason", { length: 32 }).$type<TokenRevokedReason>(),
	revokedByMemberId: integer("revoked_by_member_id"),
}, (table) => [
	unique("personal_access_tokens_token_hash_key").on(table.tokenHash),
	index("personal_access_tokens_member_id_idx").on(table.memberId),
]);
