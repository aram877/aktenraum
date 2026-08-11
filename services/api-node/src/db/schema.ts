import { pgTable, varchar, unique, serial, timestamp, jsonb, boolean, numeric } from "drizzle-orm/pg-core"
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
