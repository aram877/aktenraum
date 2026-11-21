import { logger } from "@aktenraum/core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { loadSettings, type Settings } from "../config/settings.js";
import { toNodePostgresUrl, type Database } from "../db/db.module.js";
import * as schema from "../db/schema.js";
import { credentialAudit, members, users } from "../db/schema.js";
import { reconcileTenancy } from "../tenancy/reconcile.js";
import { notRemoved } from "../tenancy/removed.js";
import { createSetupLink } from "./setup-links.js";

/**
 * Host-side last resort (auth-passkeys design §7): prints a single-use setup
 * link (30 minutes) for any member, straight from the database — for the
 * first run and for a household where nobody can sign in any more.
 *
 *   docker compose exec aktenraum-api node dist/auth/setup-link-cli.js <username>
 *
 * stdout: the link. Exit codes: 0 ok, 2 usage, 4 no such (active) member.
 */

export class UnknownMemberError extends Error {
  constructor(username: string) {
    super(`No active member named "${username}"`);
  }
}

/** Issues the link and returns `<first WEBAUTHN_ORIGINS entry>/setup/<token>`. */
export async function issueSetupLinkForUsername(db: Database, settings: Settings, username: string): Promise<string> {
  // The bootstrap user may not have its member row yet if the api never started.
  await reconcileTenancy(db);
  const rows = await db
    .select({ memberId: members.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(users.username, username), notRemoved(members.id)))
    .limit(1);
  const memberId = rows[0]?.memberId;
  if (memberId === undefined) throw new UnknownMemberError(username);
  const link = await createSetupLink(db, memberId, null);
  // Recorded in the audit only: the logger writes to stdout, which must carry nothing but the link.
  await db.insert(credentialAudit).values({ event: "setup_link_created", memberId, actorMemberId: null, detail: "host" });
  const origin = settings.WEBAUTHN_ORIGINS[0]!.replace(/\/$/, "");
  return `${origin}/setup/${link.token}`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const username = argv[0]?.trim();
  if (!username || argv.length !== 1) {
    process.stderr.write("Usage: node dist/auth/setup-link-cli.js <username>\n");
    return 2;
  }
  const settings = loadSettings(process.env);
  const pool = new Pool({ connectionString: toNodePostgresUrl(settings.DATABASE_URL) });
  try {
    const db = drizzle(pool, { schema }) as Database;
    const url = await issueSetupLinkForUsername(db, settings, username);
    process.stdout.write(`${url}\n`);
    process.stderr.write("Einrichtungslink (einmalig, 30 Minuten gültig) — im Browser öffnen und einen Passkey anlegen.\n");
    return 0;
  } catch (error: unknown) {
    if (error instanceof UnknownMemberError) {
      process.stderr.write(`${error.message}\n`);
      return 4;
    }
    throw error;
  } finally {
    await pool.end();
  }
}

const isEntrypoint = process.argv[1] !== undefined && process.argv[1].replace(/\\/g, "/").endsWith("auth/setup-link-cli.js");
if (isEntrypoint) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      logger.error("setup_link_cli_failed", { error: error instanceof Error ? error.message : String(error) });
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
