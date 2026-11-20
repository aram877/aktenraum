import { logger } from "@aktenraum/core";
import { BadGatewayException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { DB, type Database } from "../db/db.module.js";
import {
  documentSpaces,
  memberRemovals,
  members,
  spaceMembers,
  spaces,
  uploadTaskMembers,
  uploadTaskSpaces,
} from "../db/schema.js";
import { extractDocId } from "../documents/documents.service.js";
import { PaperlessRequestError } from "../paperless/errors.js";
import { PaperlessGatewayProvider } from "../paperless/paperless.module.js";
import { mirrorDocument, type MirrorOutcome } from "./paperless-mirror.js";
import { TenancyService } from "./tenancy.service.js";

/**
 * An upload task younger than this that hasn't finished may still produce the
 * document. Compared inside Postgres so app and database clocks can't disagree.
 */
const PENDING_UPLOAD_WINDOW = sql.raw("interval '1 hour'");
/** How many removals deep a successor chain is followed before falling back to the admin. */
const MAX_SUCCESSOR_DEPTH = 10;
const RUNNING_STATUSES: ReadonlySet<string> = new Set(["PENDING", "RECEIVED", "STARTED", "RETRY"]);
/** `upload_task_members.paperless_doc_id` for a task that finished without a document. */
export const NO_DOCUMENT = 0;

export type HomeSpaceSource = "existing" | "upload" | "default";

export interface HomeSpaceAssignment {
  document_id: number;
  space_id: number;
  source: HomeSpaceSource;
  paperless: MirrorOutcome;
}

interface Uploader {
  memberId: number;
  taskId: string;
}

export class UploadStillRunningError extends ConflictException {
  constructor(docId: number) {
    super(`Document ${docId}: an aktenraum upload is still being processed; retry shortly`);
  }
}

/**
 * Gives a new document its home space (ADR-009) before the worker extracts it:
 * for aktenraum uploads the space chosen at upload (still owner/editor) or
 * else the uploader's personal space, otherwise the household admin's. A document that already has one keeps it (reprocess), and
 * the Paperless owner + permissions are brought in line either way.
 */
@Injectable()
export class HomeSpaceService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly gatewayProvider: PaperlessGatewayProvider,
    private readonly tenancy: TenancyService,
  ) {}

  async assign(docId: number): Promise<HomeSpaceAssignment> {
    const gateway = this.gatewayProvider.service();
    let source: HomeSpaceSource = "existing";
    let spaceId = await this.homeSpaceOf(docId);

    if (spaceId === null) {
      const uploader = await this.uploaderOf(docId);
      const target = uploader !== null ? await this.uploadTarget(docId, uploader) : await this.adminSpace();
      await this.db
        .insert(documentSpaces)
        .values({ paperlessDocId: docId, spaceId: target })
        .onConflictDoNothing();
      // A concurrent call may have won; its row is the truth.
      spaceId = (await this.homeSpaceOf(docId)) ?? target;
      source = uploader !== null ? "upload" : "default";
      logger.info("home_space_assigned", { doc_id: docId, space_id: spaceId, source });
    }

    let paperless: MirrorOutcome;
    try {
      paperless = await mirrorDocument(this.db, gateway, docId);
    } catch (error: unknown) {
      if (error instanceof PaperlessRequestError) {
        logger.error("home_space_mirror_failed", { doc_id: docId, status: error.status });
        throw new BadGatewayException(`Paperless rejected the permissions for document ${docId}`);
      }
      throw error;
    }
    return { document_id: docId, space_id: spaceId, source, paperless };
  }

  /**
   * The space picked at upload, if the uploader may still place documents
   * there; otherwise (no pick, or rights revoked meanwhile) their personal space.
   */
  private async uploadTarget(docId: number, uploader: Uploader): Promise<number> {
    // An upload by a member removed meanwhile lands with their successor
    // (tenancy-member-removal), whatever space was picked.
    const current = await this.currentMemberFor(uploader.memberId);
    if (current !== uploader.memberId) {
      logger.info("home_space_upload_by_removed_member", {
        doc_id: docId,
        member_id: uploader.memberId,
        successor_id: current,
      });
      return current === null ? this.adminSpace() : this.personalSpaceOf(current);
    }
    const picked = await this.db
      .select({ spaceId: uploadTaskSpaces.spaceId })
      .from(uploadTaskSpaces)
      .where(eq(uploadTaskSpaces.taskId, uploader.taskId))
      .limit(1);
    const spaceId = picked[0]?.spaceId;
    if (spaceId !== undefined) {
      const allowed = await this.db
        .select({ role: spaceMembers.role })
        .from(spaceMembers)
        .where(
          and(
            eq(spaceMembers.spaceId, spaceId),
            eq(spaceMembers.memberId, uploader.memberId),
            inArray(spaceMembers.role, ["owner", "editor"]),
          ),
        )
        .limit(1);
      if (allowed.length > 0) return spaceId;
      logger.warn("home_space_upload_target_revoked", {
        doc_id: docId,
        space_id: spaceId,
        member_id: uploader.memberId,
      });
    }
    return this.personalSpaceOf(uploader.memberId);
  }

  private async homeSpaceOf(docId: number): Promise<number | null> {
    const rows = await this.db
      .select({ spaceId: documentSpaces.spaceId })
      .from(documentSpaces)
      .where(eq(documentSpaces.paperlessDocId, docId))
      .limit(1);
    return rows[0]?.spaceId ?? null;
  }

  /**
   * The member whose aktenraum upload created `docId`, or null. Unfinished
   * upload tasks are resolved against Paperless once and remembered; while a
   * recent one is still running the answer isn't known yet, so this refuses
   * (409) instead of guessing — the worker retries on its next poll.
   */
  private async uploaderOf(docId: number): Promise<Uploader | null> {
    const known = await this.db
      .select({ memberId: uploadTaskMembers.memberId, taskId: uploadTaskMembers.taskId })
      .from(uploadTaskMembers)
      .where(eq(uploadTaskMembers.paperlessDocId, docId))
      .limit(1);
    if (known[0] !== undefined) return known[0];

    const unresolved = await this.db
      .select({
        taskId: uploadTaskMembers.taskId,
        memberId: uploadTaskMembers.memberId,
        recent: sql<boolean>`${uploadTaskMembers.createdAt} > now() - ${PENDING_UPLOAD_WINDOW}`,
      })
      .from(uploadTaskMembers)
      .where(isNull(uploadTaskMembers.paperlessDocId))
      .orderBy(asc(uploadTaskMembers.createdAt));
    if (unresolved.length === 0) return null;

    const gateway = this.gatewayProvider.service();
    let match: Uploader | null = null;
    let stillRunning = false;
    for (const row of unresolved) {
      const payload = await gateway.getTasks(row.taskId);
      const task = (Array.isArray(payload) ? payload[0] : undefined) as Record<string, unknown> | undefined;
      const status = String(task?.status ?? "").toUpperCase();
      const created = task !== undefined ? extractDocId(task) : null;
      if (created !== null) {
        await this.resolve(row.taskId, created);
        if (created === docId) match = { memberId: row.memberId, taskId: row.taskId };
      } else if (status === "SUCCESS" || status === "FAILURE" || status === "REVOKED") {
        await this.resolve(row.taskId, NO_DOCUMENT);
      } else if ((task === undefined || RUNNING_STATUSES.has(status)) && row.recent) {
        stillRunning = true;
      }
    }
    if (match !== null) return match;
    if (stillRunning) throw new UploadStillRunningError(docId);
    return null;
  }

  private async resolve(taskId: string, docId: number): Promise<void> {
    await this.db
      .update(uploadTaskMembers)
      .set({ paperlessDocId: docId })
      .where(and(eq(uploadTaskMembers.taskId, taskId), isNull(uploadTaskMembers.paperlessDocId)));
  }

  /**
   * The member itself, or — when removed — its successor, followed through
   * later removals (A → B → C). null when the chain is deeper than
   * `MAX_SUCCESSOR_DEPTH` (or loops): the caller falls back to the admin.
   */
  private async currentMemberFor(memberId: number): Promise<number | null> {
    let current = memberId;
    for (let depth = 0; depth <= MAX_SUCCESSOR_DEPTH; depth += 1) {
      const rows = await this.db
        .select({ successorId: memberRemovals.successorId })
        .from(memberRemovals)
        .where(eq(memberRemovals.memberId, current))
        .limit(1);
      const next = rows[0]?.successorId;
      if (next === undefined) return current;
      current = next;
    }
    return null;
  }

  private async personalSpaceOf(memberId: number): Promise<number> {
    const rows = await this.db
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.personalMemberId, memberId))
      .limit(1);
    if (rows[0] !== undefined) return rows[0].id;
    await this.tenancy.reconcile();
    const again = await this.db
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.personalMemberId, memberId))
      .limit(1);
    if (again[0] === undefined) throw new Error(`member ${memberId} has no personal space`);
    return again[0].id;
  }

  private async adminSpace(): Promise<number> {
    const admins = await this.db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.role, "admin"))
      .orderBy(asc(members.id))
      .limit(1);
    if (admins[0] === undefined) {
      await this.tenancy.reconcile();
      const retry = await this.db
        .select({ id: members.id })
        .from(members)
        .where(eq(members.role, "admin"))
        .orderBy(asc(members.id))
        .limit(1);
      if (retry[0] === undefined) {
        throw new ConflictException("No household admin yet — create the first user before importing");
      }
      return this.personalSpaceOf(retry[0].id);
    }
    return this.personalSpaceOf(admins[0].id);
  }
}
