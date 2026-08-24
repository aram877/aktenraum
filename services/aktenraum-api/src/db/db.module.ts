import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { SETTINGS, type Settings } from "../config/settings.js";
import * as schema from "./schema.js";

export const DB = Symbol("AKTENRAUM_DB");
export const DB_POOL = Symbol("AKTENRAUM_DB_POOL");

export type Database = NodePgDatabase<typeof schema>;

export function toNodePostgresUrl(databaseUrl: string): string {
  return databaseUrl.replace(/^postgresql\+asyncpg:\/\//, "postgresql://");
}

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [SETTINGS],
      useFactory: (settings: Settings) =>
        new Pool({ connectionString: toNodePostgresUrl(settings.DATABASE_URL) }),
    },
    {
      provide: DB,
      inject: [DB_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
    },
  ],
  exports: [DB, DB_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
