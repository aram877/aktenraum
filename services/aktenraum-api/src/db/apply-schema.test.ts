import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));

async function read(name: string): Promise<string> {
  return readFile(join(here, name), "utf8");
}

describe("schema.sql", () => {
  it("creates every table the Drizzle schema declares", async () => {
    const sql = await read("schema.sql");
    const declared = Object.values(schema)
      .filter((value): value is Parameters<typeof getTableName>[0] => {
        try {
          getTableName(value as Parameters<typeof getTableName>[0]);
          return true;
        } catch {
          return false;
        }
      })
      .map((table) => getTableName(table));

    expect(declared.length).toBeGreaterThan(0);
    for (const table of declared) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
  });

  it("is re-runnable: every CREATE TABLE is guarded", async () => {
    const sql = await read("schema.sql");
    const creates = sql.match(/CREATE TABLE(?! IF NOT EXISTS)/g);
    expect(creates).toBeNull();
  });

  it("does not drop or truncate anything", async () => {
    const sql = await read("schema.sql");
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM)\b/i);
  });

  it("seeds alembic_version only when empty, so a Python rollback does not replay migrations", async () => {
    const sql = await read("schema.sql");
    expect(sql).toContain('INSERT INTO "alembic_version"');
    expect(sql).toContain("WHERE NOT EXISTS");
  });

  it("stays consistent with the drizzle-kit introspection it was derived from", async () => {
    const introspected = await read("0000_certain_guardian.sql");
    const sql = await read("schema.sql");
    const columnsOf = (text: string, table: string): string[] => {
      const match = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? "${table}" \\(([^;]*?)\\n\\);`, "s").exec(text);
      if (!match) return [];
      return [...match[1].matchAll(/^\s*"([a-z_]+)"/gm)].map((m) => m[1]);
    };
    for (const table of ["users", "document_type_fields", "app_settings", "auto_approve_rules"]) {
      const fromIntrospection = columnsOf(introspected, table);
      expect(fromIntrospection.length).toBeGreaterThan(0);
      expect(columnsOf(sql, table)).toEqual(fromIntrospection);
    }
  });
});
