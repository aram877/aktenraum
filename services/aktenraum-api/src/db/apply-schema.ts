import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "@aktenraum/core";
import { Pool } from "pg";

import { toNodePostgresUrl } from "./db.module.js";

const SCHEMA_FILENAME = "schema.sql";

async function readSchemaSql(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, SCHEMA_FILENAME),
    join(here, "..", "..", "src", "db", SCHEMA_FILENAME),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      continue;
    }
  }
  throw new Error(`Could not locate ${SCHEMA_FILENAME} (looked in: ${candidates.join(", ")})`);
}

export async function applySchema(databaseUrl: string): Promise<void> {
  const sql = await readSchemaSql();
  const pool = new Pool({ connectionString: toNodePostgresUrl(databaseUrl) });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    logger.info("db_schema_ready");
  } finally {
    await pool.end();
  }
}
