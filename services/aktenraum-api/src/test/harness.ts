import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { drizzle } from "drizzle-orm/node-postgres";
import { newDb } from "pg-mem";

import { AppModule } from "../app.module.js";
import { FastApiErrorShapeFilter } from "../common/http-exception.filter.js";
import { createCsrfMiddleware, securityHeadersMiddleware } from "../common/middleware.js";
import { SETTINGS, loadSettings, type Settings } from "../config/settings.js";
import { DB, DB_POOL, type Database } from "../db/db.module.js";
import * as schema from "../db/schema.js";
import { PAPERLESS_GATEWAY } from "../paperless/paperless.module.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import type { LLMBackend } from "@aktenraum/core";

import { LlmBackendProvider, type BackendRole } from "../ai/llm-backend.provider.js";
import { RETRIEVAL_DEPS } from "../ai/retrieval.module.js";
import type { RetrievalDeps } from "../ai/retrieval.js";
import { VECTOR_STORE } from "../rag/rag.module.js";

const SCHEMA_SQL = `
CREATE TABLE users (
  id serial PRIMARY KEY,
  username varchar(64) NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE document_type_fields (
  paperless_doc_id integer PRIMARY KEY,
  document_type varchar(64) NOT NULL,
  fields jsonb NOT NULL DEFAULT '{}',
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE app_settings (
  id integer PRIMARY KEY,
  llm_model varchar(128) NOT NULL DEFAULT 'qwen2.5:14b-instruct-q8_0',
  answer_llm_model varchar(128) NOT NULL DEFAULT 'qwen2.5:14b-instruct-q8_0',
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE auto_approve_rules (
  document_type varchar(64) PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  min_confidence numeric(3,2) NOT NULL DEFAULT 0.90,
  updated_at timestamp with time zone,
  updated_by varchar(255)
);
INSERT INTO app_settings (id) VALUES (1);
`;

export const TEST_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://test/test",
  JWT_SECRET: "test-secret-not-for-prod-32-bytes-min",
  JWT_EXPIRES_SECONDS: "3600",
  COOKIE_SECURE: "false",
  BOOTSTRAP_USERNAME: "",
  BOOTSTRAP_PASSWORD: "",
  PAPERLESS_API_TOKEN: "test-token",
  WEBHOOK_SECRET: "",
  AUTO_TAGGER_URL: "",
  QDRANT_URL: "",
};

interface QueryResultLike {
  rows: Record<string, unknown>[];
  fields?: { name: string }[];
}

interface RawPool {
  query: (config: unknown, values?: unknown) => Promise<QueryResultLike>;
  end?: () => Promise<void>;
}

function withArrayRowModeSupport(pool: RawPool): RawPool {
  const original = pool.query.bind(pool);
  pool.query = async (config: unknown, values?: unknown): Promise<QueryResultLike> => {
    if (typeof config !== "object" || config === null) return original(config, values);

    const { rowMode, types: _types, ...rest } = config as Record<string, unknown>;
    if (rowMode !== "array") return original(rest, values);

    const result = await original(rest, values);
    const columns = result.fields?.map((field) => field.name) ?? [];
    return {
      ...result,
      rows: result.rows.map((row) =>
        (columns.length > 0 ? columns : Object.keys(row)).map((name) => row[name]),
      ) as unknown as Record<string, unknown>[],
    };
  };
  return pool;
}

export interface Harness {
  app: INestApplication;
  db: Database;
  settings: Settings;
  close: () => Promise<void>;
}

export async function createHarness(options: {
  gateway?: Partial<PaperlessGateway> | null;
  env?: Record<string, string>;
  llm?: Partial<Record<BackendRole, LLMBackend>>;
  retrieval?: RetrievalDeps | null;
} = {}): Promise<Harness> {
  const settings = loadSettings({ ...TEST_ENV, ...options.env });

  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({
    name: "now",
    returns: mem.public.getType("timestamp" as never) as never,
    implementation: () => new Date(),
  });
  mem.public.none(SCHEMA_SQL);
  const pgAdapter = mem.adapters.createPg() as { Pool: new () => RawPool };
  const pool = withArrayRowModeSupport(new pgAdapter.Pool());
  const db = drizzle(pool as never, { schema }) as Database;

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SETTINGS)
    .useValue(settings)
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(DB_POOL)
    .useValue({ end: async () => undefined })
    .overrideProvider(VECTOR_STORE)
    .useValue(null)
    .overrideProvider(RETRIEVAL_DEPS)
    .useValue(options.retrieval ?? null)
    .overrideProvider(PAPERLESS_GATEWAY)
    .useValue(options.gateway === undefined ? null : options.gateway);
  const llm = options.llm;
  if (llm !== undefined) {
    builder = builder.overrideProvider(LlmBackendProvider).useValue({
      build: async (role: BackendRole) => {
        const backend = llm[role];
        if (backend === undefined) throw new Error(`no fake LLM for role ${role}`);
        return backend;
      },
    });
  }

  const moduleRef: TestingModule = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.use(securityHeadersMiddleware);
  app.use(createCsrfMiddleware(settings.WEBHOOK_SECRET));
  app.useGlobalFilters(new FastApiErrorShapeFilter());
  await app.init();

  return {
    app,
    db,
    settings,
    close: async () => {
      await app.close();
    },
  };
}
