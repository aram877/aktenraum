import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { drizzle } from "drizzle-orm/node-postgres";
import { newDb } from "pg-mem";

import { AppModule } from "../app.module.js";
import { FastApiErrorShapeFilter } from "../common/http-exception.filter.js";
import { createCsrfMiddleware, securityHeadersMiddleware } from "../common/middleware.js";
import { SETTINGS, loadSettings, type Settings } from "../config/settings.js";
import { DB, DB_POOL, type Database } from "../db/db.module.js";
import * as schema from "../db/schema.js";
import { PAPERLESS_GATEWAY, PAPERLESS_GATEWAY_FACTORY } from "../paperless/paperless.module.js";
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
CREATE TABLE upload_tasks (
  task_id varchar(64) PRIMARY KEY,
  file_name varchar(255),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE households (
  id serial PRIMARY KEY,
  name varchar(128) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE members (
  id serial PRIMARY KEY,
  household_id integer NOT NULL REFERENCES households(id),
  user_id integer NOT NULL UNIQUE REFERENCES users(id),
  role varchar(16) NOT NULL CHECK (role IN ('admin', 'member')),
  paperless_user_id integer UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE spaces (
  id serial PRIMARY KEY,
  household_id integer NOT NULL REFERENCES households(id),
  name varchar(128) NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('personal', 'shared')),
  personal_member_id integer UNIQUE REFERENCES members(id),
  paperless_group_id integer UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CHECK ((kind = 'personal') = (personal_member_id IS NOT NULL))
);
CREATE TABLE space_members (
  space_id integer NOT NULL REFERENCES spaces(id),
  member_id integer NOT NULL REFERENCES members(id),
  role varchar(16) NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, member_id)
);
CREATE TABLE document_spaces (
  paperless_doc_id integer PRIMARY KEY,
  space_id integer NOT NULL REFERENCES spaces(id),
  assigned_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE upload_task_members (
  task_id varchar(64) PRIMARY KEY,
  member_id integer NOT NULL REFERENCES members(id),
  paperless_doc_id integer,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE member_paperless_tokens (
  member_id integer PRIMARY KEY REFERENCES members(id),
  ciphertext text NOT NULL,
  iv varchar(32) NOT NULL,
  auth_tag varchar(32) NOT NULL,
  key_id varchar(16) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE invites (
  id serial PRIMARY KEY,
  token_hash varchar(64) NOT NULL UNIQUE,
  household_id integer NOT NULL REFERENCES households(id),
  role varchar(16) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_by_member_id integer NOT NULL REFERENCES members(id),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  redeemed_at timestamp with time zone,
  redeemed_by_member_id integer REFERENCES members(id),
  revoked_at timestamp with time zone
);
CREATE TABLE space_paperless_groups (
  space_id integer PRIMARY KEY REFERENCES spaces(id),
  viewer_group_id integer NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE upload_task_spaces (
  task_id varchar(64) PRIMARY KEY,
  space_id integer NOT NULL REFERENCES spaces(id),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE document_shares (
  id serial PRIMARY KEY,
  paperless_doc_id integer NOT NULL,
  member_id integer NOT NULL REFERENCES members(id),
  role varchar(16) NOT NULL CHECK (role IN ('viewer', 'editor')),
  expires_at timestamp with time zone,
  granted_by integer NOT NULL REFERENCES members(id),
  granted_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (paperless_doc_id, member_id)
);
CREATE TABLE share_audit (
  id bigserial PRIMARY KEY,
  paperless_doc_id integer NOT NULL,
  member_id integer NOT NULL,
  actor_member_id integer,
  event varchar(16) NOT NULL CHECK (event IN ('granted', 'role_changed', 'expiry_changed', 'revoked', 'expired', 'accessed')),
  access_kind varchar(16) CHECK (access_kind IS NULL OR access_kind IN ('detail', 'preview', 'download', 'ask')),
  at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE member_removals (
  member_id integer PRIMARY KEY REFERENCES members(id),
  successor_id integer NOT NULL REFERENCES members(id),
  removed_by integer NOT NULL REFERENCES members(id),
  removed_at timestamp with time zone NOT NULL DEFAULT now(),
  phase varchar(16) NOT NULL DEFAULT 'db' CHECK (phase IN ('db', 'derived', 'done')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  completed_at timestamp with time zone,
  CHECK (successor_id <> member_id)
);
CREATE TABLE member_removal_documents (
  member_id integer NOT NULL REFERENCES member_removals(member_id),
  paperless_doc_id integer NOT NULL,
  synced_at timestamp with time zone,
  trashed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (member_id, paperless_doc_id)
);
CREATE TABLE sessions (
  id bigserial PRIMARY KEY,
  token_hash varchar(64) NOT NULL UNIQUE,
  member_id integer NOT NULL REFERENCES members(id),
  household_id integer NOT NULL REFERENCES households(id),
  client_id varchar(32) NOT NULL DEFAULT 'spa',
  auth_method varchar(16) NOT NULL CHECK (auth_method IN ('password', 'invite', 'passkey', 'recovery', 'setup')),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  idle_expires_at timestamp with time zone NOT NULL,
  absolute_expires_at timestamp with time zone NOT NULL,
  step_up_at timestamp with time zone,
  user_agent varchar(512),
  ip varchar(64),
  revoked_at timestamp with time zone,
  revoked_reason varchar(32) CHECK (revoked_reason IS NULL OR revoked_reason IN ('logout', 'user', 'other_device', 'password_change', 'member_removed'))
);
CREATE TABLE auth_rate_limit_events (
  id bigserial PRIMARY KEY,
  key varchar(160) NOT NULL,
  at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE auth_audit (
  id bigserial PRIMARY KEY,
  at timestamp with time zone NOT NULL DEFAULT now(),
  event varchar(32) NOT NULL CHECK (event IN ('login_succeeded', 'login_failed', 'login_throttled', 'logout', 'session_revoked', 'password_changed', 'invite_redeemed')),
  member_id integer,
  actor_member_id integer,
  session_id bigint,
  username varchar(64),
  reason varchar(32),
  ip varchar(64),
  user_agent varchar(512)
);
CREATE TABLE webauthn_users (
  member_id integer PRIMARY KEY REFERENCES members(id),
  user_handle varchar(86) NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE passkeys (
  id serial PRIMARY KEY,
  member_id integer NOT NULL REFERENCES members(id),
  credential_id varchar(1366) NOT NULL UNIQUE,
  public_key text NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0,
  transports varchar(128),
  aaguid varchar(36),
  device_type varchar(16) NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up boolean NOT NULL,
  prf_enabled boolean NOT NULL DEFAULT false,
  rp_id varchar(253) NOT NULL,
  name varchar(64) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone,
  removed_at timestamp with time zone
);
CREATE TABLE webauthn_challenges (
  id bigserial PRIMARY KEY,
  ceremony varchar(43) NOT NULL UNIQUE,
  challenge varchar(128) NOT NULL,
  kind varchar(16) NOT NULL,
  purpose varchar(16) NOT NULL,
  member_id integer,
  session_id bigint,
  invite_id integer,
  setup_token_id integer,
  username varchar(64),
  user_handle varchar(86),
  rp_id varchar(253) NOT NULL,
  origin varchar(255) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone
);
CREATE TABLE recovery_codes (
  id serial PRIMARY KEY,
  member_id integer NOT NULL REFERENCES members(id),
  batch_id varchar(32) NOT NULL,
  code_hash varchar(64) NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  used_at timestamp with time zone,
  invalidated_at timestamp with time zone
);
CREATE TABLE setup_tokens (
  id serial PRIMARY KEY,
  token_hash varchar(64) NOT NULL UNIQUE,
  member_id integer NOT NULL REFERENCES members(id),
  created_by_member_id integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  revoked_at timestamp with time zone
);
CREATE TABLE password_retirements (
  member_id integer PRIMARY KEY REFERENCES members(id),
  retired_at timestamp with time zone NOT NULL DEFAULT now(),
  session_id bigint
);
CREATE TABLE credential_audit (
  id bigserial PRIMARY KEY,
  at timestamp with time zone NOT NULL DEFAULT now(),
  event varchar(32) NOT NULL,
  member_id integer,
  actor_member_id integer,
  session_id bigint,
  passkey_id integer,
  detail varchar(128),
  ip varchar(64),
  user_agent varchar(512)
);
CREATE TABLE personal_access_tokens (
  id serial PRIMARY KEY,
  member_id integer NOT NULL REFERENCES members(id),
  household_id integer NOT NULL REFERENCES households(id),
  name varchar(64) NOT NULL,
  token_hash varchar(64) NOT NULL UNIQUE,
  display_prefix varchar(16) NOT NULL,
  scopes varchar(256) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  last_used_at timestamp with time zone,
  last_used_ip varchar(64),
  expired_audit_at timestamp with time zone,
  revoked_at timestamp with time zone,
  revoked_reason varchar(32),
  revoked_by_member_id integer
);
INSERT INTO app_settings (id) VALUES (1);
`;

/** Service credentials for tests that act as the worker (ADR-010 step 5). */
export const TEST_WORKER_TOKEN = "akt_svc_test_worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const TEST_API_TOKEN = "akt_svc_test_api_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** `env` for `createHarness` that configures both api-side service credentials. */
export const SERVICE_ENV = { SVC_TOKEN_WORKER: TEST_WORKER_TOKEN, SVC_TOKEN_API: TEST_API_TOKEN };

/** Sends a supertest request as the worker (`Authorization: Bearer <token>`). */
export function asWorker<T extends { set(field: string, value: string): T }>(
  req: T,
  token: string = TEST_WORKER_TOKEN,
): T {
  return req.set("Authorization", `Bearer ${token}`);
}

export const TEST_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://test/test",
  AKTENRAUM_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  COOKIE_SECURE: "false",
  BOOTSTRAP_USERNAME: "",
  BOOTSTRAP_PASSWORD: "",
  PAPERLESS_API_TOKEN: "test-token",
  SVC_TOKEN_WORKER: "",
  SVC_TOKEN_API: "",
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

function createTestDatabase(): Database {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({
    name: "now",
    returns: mem.public.getType("timestamp" as never) as never,
    implementation: () => new Date(),
  });
  mem.public.none(SCHEMA_SQL);
  const pgAdapter = mem.adapters.createPg() as { Pool: new () => RawPool };
  const pool = withArrayRowModeSupport(new pgAdapter.Pool());
  return drizzle(pool as never, { schema }) as Database;
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
  /** A fake `QdrantVectorStore`; default null (RAG off). */
  vectorStore?: unknown;
  /** Reuse another harness's database — a "restarted" api on the same data. */
  db?: Database;
} = {}): Promise<Harness> {
  const settings = loadSettings({ ...TEST_ENV, ...options.env });
  const db = options.db ?? createTestDatabase();

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SETTINGS)
    .useValue(settings)
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(DB_POOL)
    .useValue({ end: async () => undefined })
    .overrideProvider(VECTOR_STORE)
    .useValue(options.vectorStore ?? null)
    .overrideProvider(RETRIEVAL_DEPS)
    .useValue(options.retrieval ?? null)
    .overrideProvider(PAPERLESS_GATEWAY)
    .useValue(options.gateway === undefined ? null : options.gateway)
    // Member tokens: a FakeGateway hands out per-token views; anything else
    // (partial stubs) serves members with the same object.
    .overrideProvider(PAPERLESS_GATEWAY_FACTORY)
    .useValue((token: string) => {
      const gateway = options.gateway as { forToken?: (t: string) => unknown } | null | undefined;
      return typeof gateway?.forToken === "function" ? gateway.forToken(token) : gateway;
    });
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
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.set("trust proxy", 1); // as in main.ts
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.use(securityHeadersMiddleware);
  app.use(createCsrfMiddleware());
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
