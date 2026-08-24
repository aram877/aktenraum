import { DOCUMENT_TYPES, logger } from "@aktenraum/core";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";

import { SETTINGS, type Settings } from "../config/settings.js";
import { DB, type Database } from "../db/db.module.js";
import { appSettings, autoApproveRules } from "../db/schema.js";
import { DEFAULT_MODEL, type AutoApproveRule, type AutoApproveRulesUpdate } from "./settings.schemas.js";

const SINGLETON_ID = 1;
const DEFAULT_MIN_CONFIDENCE = "0.90";
const OLLAMA_LIST_TIMEOUT_MS = 3_000;

export function toIsoTimestamp(value: string | null): string | null {
  if (value === null || value === "") return null;
  const normalised = value
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

interface AppSettingsRow {
  id: number;
  llmModel: string;
  answerLlmModel: string;
}

@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reconcileMissingRules();
  }

  async getRow(): Promise<AppSettingsRow> {
    const rows = await this.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.id, SINGLETON_ID))
      .limit(1);
    const existing = rows[0];
    if (existing !== undefined) return existing;

    const inserted = await this.db
      .insert(appSettings)
      .values({ id: SINGLETON_ID, llmModel: DEFAULT_MODEL, answerLlmModel: DEFAULT_MODEL })
      .returning();
    return inserted[0] as AppSettingsRow;
  }

  async getActiveModel(): Promise<string> {
    return (await this.getRow()).llmModel;
  }

  async setActiveModel(model: string): Promise<string> {
    const updated = await this.db
      .update(appSettings)
      .set({ llmModel: model })
      .where(eq(appSettings.id, SINGLETON_ID))
      .returning();
    if (updated[0] !== undefined) return updated[0].llmModel;
    await this.getRow();
    return this.setActiveModel(model);
  }

  async getActiveAnswerModel(): Promise<string> {
    return (await this.getRow()).answerLlmModel;
  }

  async setActiveAnswerModel(model: string): Promise<string> {
    const updated = await this.db
      .update(appSettings)
      .set({ answerLlmModel: model })
      .where(eq(appSettings.id, SINGLETON_ID))
      .returning();
    if (updated[0] !== undefined) return updated[0].answerLlmModel;
    await this.getRow();
    return this.setActiveAnswerModel(model);
  }

  async listAvailableModels(): Promise<string[]> {
    if (this.settings.LLM_BACKEND.toLowerCase() !== "ollama") return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_LIST_TIMEOUT_MS);
    try {
      const base = this.settings.OLLAMA_BASE_URL.replace(/\/+$/, "");
      const resp = await fetch(`${base}/api/tags`, { signal: controller.signal });
      if (!resp.ok) return [];
      const payload = (await resp.json()) as { models?: { model?: string; name?: string }[] };
      return (payload.models ?? [])
        .map((entry) => entry.model ?? entry.name)
        .filter((tag): tag is string => typeof tag === "string" && tag !== "");
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async listRules(): Promise<AutoApproveRule[]> {
    const rows = await this.db
      .select()
      .from(autoApproveRules)
      .orderBy(asc(autoApproveRules.documentType));
    return rows.map((row) => ({
      document_type: row.documentType,
      enabled: row.enabled,
      min_confidence: Number(row.minConfidence),
      updated_at: toIsoTimestamp(row.updatedAt ?? null),
      updated_by: row.updatedBy ?? null,
    }));
  }

  async replaceRules(
    payload: AutoApproveRulesUpdate,
    updatedBy: string,
  ): Promise<AutoApproveRule[]> {
    const now = new Date().toISOString();
    for (const entry of payload.rules) {
      await this.db
        .insert(autoApproveRules)
        .values({
          documentType: entry.document_type,
          enabled: entry.enabled,
          minConfidence: entry.min_confidence.toFixed(2),
          updatedAt: now,
          updatedBy,
        })
        .onConflictDoUpdate({
          target: autoApproveRules.documentType,
          set: {
            enabled: entry.enabled,
            minConfidence: entry.min_confidence.toFixed(2),
            updatedAt: now,
            updatedBy,
          },
        });
    }
    return this.listRules();
  }

  async reconcileMissingRules(): Promise<number> {
    const rows = await this.db
      .select({ documentType: autoApproveRules.documentType })
      .from(autoApproveRules);
    const existing = new Set(rows.map((row) => row.documentType));
    const missing = DOCUMENT_TYPES.filter((type) => !existing.has(type)).sort();
    if (missing.length === 0) return 0;
    await this.db.insert(autoApproveRules).values(
      missing.map((documentType) => ({
        documentType,
        enabled: false,
        minConfidence: DEFAULT_MIN_CONFIDENCE,
      })),
    );
    logger.info("auto_approve_rules_reconciled", { inserted: missing.length });
    return missing.length;
  }
}
