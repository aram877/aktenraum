import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";

import { DB, type Database } from "../db/db.module.js";
import { logTenancyReport, reconcileTenancy, type TenancyReconcileReport } from "./reconcile.js";

@Injectable()
export class TenancyService implements OnApplicationBootstrap {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Runs after every module's `onModuleInit`, so the bootstrap user that
   * `AuthService` may have just created already exists.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
  }

  async reconcile(): Promise<TenancyReconcileReport> {
    const report = await reconcileTenancy(this.db);
    logTenancyReport(report);
    return report;
  }
}
