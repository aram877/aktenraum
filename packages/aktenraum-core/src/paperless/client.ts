import type { DocumentExtraction } from "../models/extraction.js";
import { logger } from "../log.js";
import { normalizeDate, truncateForField } from "./normalisers.js";

// Per-process cache TTL for entity lookups. Five minutes is short enough
// that a manual Paperless edit (delete a tag, rename a correspondent) is
// picked up within a poll cycle; long enough that the worker's poll loop
// doesn't smash Paperless with the same six tag-id lookups every 30s.
// Invalidation: any create-path (getOrCreateNamed, ensureTag,
// ensureCustomField) drops its own cache key so freshly-created entities
// are immediately available.
const DEFAULT_CACHE_TTL_SECONDS = 300;

// Tags that mark a document as having entered the AI pipeline. The worker
// excludes documents carrying any of these from its unprocessed-doc query,
// and the propagator filters by individual states (ai-approved,
// ai-propagated, …).
//
// Auxiliary tags (NOT lifecycle states, intentionally excluded from this
// tuple so the poller's "no lifecycle tag" filter doesn't change behaviour):
//   - `ai-auto-approved`: set alongside ai-approved when the routing gate
//     fires; persists through propagation so the SPA can render the
//     "auto-genehmigt" badge.
//   - `ai-low-confidence`: review-queue priority flag; coexists with
//     ai-pending when extraction confidence is below the threshold.
//   - `ai-duplicate`: propagator-applied flag indicating the doc matched
//     another propagated doc on correspondent + issue_date + (amount or
//     reference number). Persists through every lifecycle state; the user
//     filters Library by it to resolve duplicates via the Löschen flow.
export const LIFECYCLE_TAGS = [
  "ai-pending",
  "ai-approved",
  "ai-rejected",
  "ai-propagated",
  "ai-propagation-error",
  "ai-error",
] as const;

export class PaperlessHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`Paperless request failed: ${status} ${url}`);
    this.name = "PaperlessHttpError";
  }
}

export type PaperlessDocument = Record<string, unknown> & { id: number };

interface CacheEntry<T> {
  when: number;
  value: T;
}

interface PaperlessListResponse<T> {
  results: T[];
}

export interface PaperlessClientOptions {
  cacheTtlSeconds?: number;
  /** Injectable for tests — defaults to the global fetch. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function raiseForStatus(resp: Response, bodyText?: string): void {
  if (resp.status >= 400) {
    throw new PaperlessHttpError(resp.status, bodyText ?? "", resp.url);
  }
}

export class PaperlessClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly cacheTtlSeconds: number;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  // name → {when, tag_id}. null values are cached too so a missing tag
  // doesn't trigger a fresh GET every 30s during the poller's
  // LIFECYCLE_TAGS scan.
  private tagIdCache = new Map<string, CacheEntry<number | null>>();
  private customFieldIdsCache: CacheEntry<Record<string, number>> | null = null;
  // endpoint → {when, {id: name}}
  private entityNameMapCache = new Map<string, CacheEntry<Record<number, string>>>();

  constructor(baseUrl: string, apiToken: string, options: PaperlessClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.headers = { Authorization: `Token ${apiToken}` };
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Drop every per-process entity cache. Call this when something
   * out-of-band changed Paperless state (e.g. the operator just ran
   * scripts/bootstrap-paperless.sh and we need newly-created custom fields
   * to resolve immediately).
   */
  invalidateCaches(): void {
    this.tagIdCache.clear();
    this.customFieldIdsCache = null;
    this.entityNameMapCache.clear();
  }

  // ------------------------------------------------------------------
  // Internal HTTP plumbing
  // ------------------------------------------------------------------

  private buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request(
    method: string,
    path: string,
    options: {
      params?: Record<string, string | number | undefined>;
      json?: unknown;
    } = {},
  ): Promise<Response> {
    const url = this.buildUrl(path, options.params);
    const init: RequestInit = { method, headers: { ...this.headers } };
    if (options.json !== undefined) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(options.json);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const resp = await this.request("GET", path, { params });
    if (!resp.ok) raiseForStatus(resp, await resp.text());
    return (await resp.json()) as T;
  }

  // ------------------------------------------------------------------
  // Documents
  // ------------------------------------------------------------------

  /** Return documents with none of the AI lifecycle tags. */
  async getUnprocessedDocuments(batchSize = 5): Promise<PaperlessDocument[]> {
    const tagIds = await Promise.all(LIFECYCLE_TAGS.map((name) => this.getTagId(name)));
    const excludeIds = tagIds.filter((id): id is number => id !== null).join(",");
    const params: Record<string, string | number | undefined> = {
      ordering: "created",
      page_size: batchSize,
    };
    if (excludeIds) params["tags__id__none"] = excludeIds;
    const data = await this.getJson<PaperlessListResponse<PaperlessDocument>>(
      "/api/documents/",
      params,
    );
    return data.results ?? [];
  }

  /** Fetch a single document by id. Returns the full doc, incl. content and custom_fields. */
  async getDocument(docId: number): Promise<PaperlessDocument> {
    return this.getJson<PaperlessDocument>(`/api/documents/${docId}/`);
  }

  async getDocumentContent(docId: number): Promise<string> {
    const doc = await this.getDocument(docId);
    return (doc.content as string | undefined) ?? "";
  }

  async patchDocumentAiFields(
    docId: number,
    extraction: DocumentExtraction,
    backendName: string,
    modelName: string,
  ): Promise<void> {
    const fieldMap = await this.getCustomFieldIds();

    // Track field names the LLM produced a value for but Paperless doesn't
    // know about. The previous behaviour was a silent skip — a single "you
    // forgot to bootstrap a new custom field" mistake then looked like an
    // LLM bug. Loud log makes the cause obvious next time.
    const missingWithValue: string[] = [];

    const fv = (name: string, value: string | number | null | undefined): { field: number; value: unknown } | null => {
      const fid = fieldMap[name];
      if (value === null || value === undefined) return null;
      if (fid === undefined) {
        missingWithValue.push(name);
        return null;
      }
      return { field: fid, value };
    };

    const customFields = [
      fv("ai_document_type", truncateForField("ai_document_type", extraction.document_type)),
      fv("ai_correspondent", truncateForField("ai_correspondent", extraction.correspondent)),
      fv("ai_title", truncateForField("ai_title", extraction.ai_title)),
      fv("ai_issue_date", normalizeDate(extraction.key_dates.issue)),
      fv(
        "ai_reference_numbers",
        truncateForField(
          "ai_reference_numbers",
          extraction.reference_numbers.join(", ") || null,
        ),
      ),
      fv(
        "ai_suggested_tags",
        truncateForField("ai_suggested_tags", extraction.suggested_tags.join(", ") || null),
      ),
      fv("ai_summary_de", truncateForField("ai_summary_de", extraction.summary_de)),
      fv("ai_confidence", extraction.confidence),
      fv(
        "ai_confidence_reason",
        truncateForField("ai_confidence_reason", extraction.confidence_reason),
      ),
      fv("ai_backend", truncateForField("ai_backend", backendName)),
      fv("ai_model", truncateForField("ai_model", modelName)),
    ];

    if (missingWithValue.length > 0) {
      // Loud, single-line warning. The cure is one command:
      // `bash scripts/bootstrap-paperless.sh` (also run by `task setup`)
      // — the script is idempotent and adds any missing custom fields.
      logger.warn("paperless_unknown_custom_fields_skipped", {
        doc_id: docId,
        missing: [...missingWithValue].sort(),
        fix: "run scripts/bootstrap-paperless.sh to create the missing fields",
      });
    }

    const resp = await this.request("PATCH", `/api/documents/${docId}/`, {
      json: { custom_fields: customFields.filter((cf) => cf !== null) },
    });
    if (resp.status >= 400) {
      // Paperless validation failures return useful detail in the body —
      // surface it instead of a bare error.
      const body = await resp.text();
      logger.error("paperless_patch_rejected", { doc_id: docId, status: resp.status, body });
      raiseForStatus(resp, body);
    }
  }

  // ------------------------------------------------------------------
  // Documents — propagation helpers
  // ------------------------------------------------------------------

  /**
   * Return documents tagged with `tagName`. Empty list if the tag is missing.
   *
   * `ordering` follows Paperless conventions ("modified" oldest-first,
   * "-modified" newest-first, etc.). The list endpoint includes the full
   * document including content and custom_fields, so callers do not need
   * per-doc GETs to inspect those.
   *
   * `extraParams` are merged into the Paperless query string after the
   * tag/ordering/page-size defaults. Lets callers narrow the scan (e.g.
   * duplicate detection passes correspondent__id to limit the candidate set
   * to one sender). User-supplied keys override the defaults.
   */
  async getDocumentsWithTag(
    tagName: string,
    batchSize = 5,
    ordering = "modified",
    extraParams?: Record<string, string | number | undefined>,
  ): Promise<PaperlessDocument[]> {
    const tagId = await this.getTagId(tagName);
    if (tagId === null) return [];
    const params: Record<string, string | number | undefined> = {
      tags__id__all: tagId,
      ordering,
      page_size: batchSize,
      ...extraParams,
    };
    const data = await this.getJson<PaperlessListResponse<PaperlessDocument>>(
      "/api/documents/",
      params,
    );
    return data.results ?? [];
  }

  /**
   * Inverse of the {name: id} map; useful when reading custom_fields off
   * documents returned by list endpoints (each item is {field, value}).
   */
  async getCustomFieldNameById(): Promise<Record<number, string>> {
    const ids = await this.getCustomFieldIds();
    const out: Record<number, string> = {};
    for (const [name, fid] of Object.entries(ids)) out[fid] = name;
    return out;
  }

  /**
   * Return {id: name} for any Paperless entity endpoint with a `name` field
   * (correspondents, document_types, tags). Used to resolve foreign keys on
   * documents returned by list endpoints.
   *
   * Cached per-endpoint with TTL cacheTtlSeconds so the propagator and the
   * indexer don't re-fetch the same correspondent/document_type/tag list on
   * every doc.
   */
  async getEntityNameMap(endpoint: string): Promise<Record<number, string>> {
    const cached = this.entityNameMapCache.get(endpoint);
    if (cached && nowSeconds() - cached.when <= this.cacheTtlSeconds) {
      return cached.value;
    }
    const data = await this.getJson<PaperlessListResponse<{ id: number; name: string }>>(
      endpoint,
      { page_size: 200 },
    );
    const result: Record<number, string> = {};
    for (const x of data.results ?? []) result[x.id] = x.name;
    this.entityNameMapCache.set(endpoint, { when: nowSeconds(), value: result });
    return result;
  }

  /**
   * Build {correspondent_name: {document_type: count}} from the most recent
   * `sampleSize` propagated documents. Drives both the per-sender prompt
   * hint and any future analytics.
   */
  async getCorrespondentHistory(sampleSize = 200): Promise<Record<string, Record<string, number>>> {
    const docs = await this.getDocumentsWithTag("ai-propagated", sampleSize, "-modified");
    if (docs.length === 0) return {};
    const correspondentNames = await this.getEntityNameMap("/api/correspondents/");
    const documentTypeNames = await this.getEntityNameMap("/api/document_types/");
    const history: Record<string, Record<string, number>> = {};
    for (const doc of docs) {
      const cId = doc.correspondent as number | null | undefined;
      const dId = doc.document_type as number | null | undefined;
      if (cId === null || cId === undefined || dId === null || dId === undefined) continue;
      const cName = correspondentNames[cId];
      const dName = documentTypeNames[dId];
      if (!cName || !dName) continue;
      history[cName] ??= {};
      history[cName][dName] = (history[cName][dName] ?? 0) + 1;
    }
    return history;
  }

  /** Return {field_name: value} for every custom field set on the doc. */
  async getAiCustomFieldValues(docId: number): Promise<Record<string, unknown>> {
    const doc = await this.getDocument(docId);
    const nameById = await this.getCustomFieldNameById();
    const out: Record<string, unknown> = {};
    const customFields = (doc.custom_fields as { field: number; value: unknown }[] | undefined) ?? [];
    for (const cf of customFields) {
      const name = nameById[cf.field];
      if (name !== undefined) out[name] = cf.value;
    }
    return out;
  }

  /**
   * Write or clear `ai_error_message` on a document.
   *
   * Merge-by-id: reads the doc's existing custom_fields, drops any prior
   * entry for ai_error_message, optionally appends the new value, and
   * PATCHes the full array back. Paperless's custom_fields PATCH is
   * full-array replace (not partial), so a naive single-field PATCH would
   * wipe every other ai_* field.
   *
   * Best-effort: any failure here is logged but never thrown. The caller is
   * almost always already handling a primary failure (extraction/
   * propagation/indexing); a secondary write failure must not mask it.
   * Likewise if the ai_error_message custom field hasn't been bootstrapped
   * yet (older install), we log + skip.
   */
  async setErrorMessage(docId: number, message: string | null): Promise<void> {
    try {
      const fieldMap = await this.getCustomFieldIds();
      const fieldId = fieldMap["ai_error_message"];
      if (fieldId === undefined) {
        logger.warn("ai_error_message_field_missing", {
          doc_id: docId,
          hint: "run scripts/bootstrap-paperless.sh to create the field",
        });
        return;
      }

      const doc = await this.getDocument(docId);
      const existing = (doc.custom_fields as { field: number; value: unknown }[] | undefined) ?? [];
      const merged = existing.filter((cf) => cf.field !== fieldId);
      if (message !== null && message.trim()) {
        merged.push({ field: fieldId, value: message });
      }

      const resp = await this.request("PATCH", `/api/documents/${docId}/`, {
        json: { custom_fields: merged },
      });
      if (resp.status >= 400) {
        logger.error("ai_error_message_write_failed", {
          doc_id: docId,
          status: resp.status,
          body: await resp.text(),
        });
      }
    } catch (exc) {
      logger.warn("ai_error_message_write_exception", {
        doc_id: docId,
        error: exc instanceof Error ? exc.message : String(exc),
      });
    }
  }

  async patchDocumentNativeFields(
    docId: number,
    fields: {
      correspondent?: number | null;
      documentType?: number | null;
      createdDate?: string | null;
      tags?: number[] | null;
      title?: string | null;
    },
  ): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (fields.correspondent !== undefined && fields.correspondent !== null) {
      payload["correspondent"] = fields.correspondent;
    }
    if (fields.documentType !== undefined && fields.documentType !== null) {
      payload["document_type"] = fields.documentType;
    }
    if (fields.createdDate !== undefined && fields.createdDate !== null) {
      payload["created_date"] = fields.createdDate;
    }
    if (fields.tags !== undefined && fields.tags !== null) {
      payload["tags"] = fields.tags;
    }
    if (fields.title !== undefined && fields.title !== null) {
      payload["title"] = fields.title;
    }
    if (Object.keys(payload).length === 0) return;

    const resp = await this.request("PATCH", `/api/documents/${docId}/`, { json: payload });
    if (resp.status >= 400) {
      const body = await resp.text();
      logger.error("paperless_patch_rejected", { doc_id: docId, status: resp.status, body });
      raiseForStatus(resp, body);
    }
  }

  // ------------------------------------------------------------------
  // Named entities — tags, correspondents, document types
  // ------------------------------------------------------------------

  async addTagToDocument(docId: number, tagName: string): Promise<void> {
    const tagId = await this.getOrCreateTag(tagName);
    const doc = await this.getDocument(docId);
    const existingTags = (doc.tags as number[] | undefined) ?? [];
    if (!existingTags.includes(tagId)) {
      const resp = await this.request("PATCH", `/api/documents/${docId}/`, {
        json: { tags: [...existingTags, tagId] },
      });
      if (!resp.ok) raiseForStatus(resp, await resp.text());
    }
  }

  async getOrCreateTag(name: string): Promise<number> {
    return this.getOrCreateNamed("/api/tags/", name);
  }

  async getOrCreateCorrespondent(name: string): Promise<number> {
    return this.getOrCreateNamed("/api/correspondents/", name);
  }

  async getOrCreateDocumentType(name: string): Promise<number> {
    return this.getOrCreateNamed("/api/document_types/", name);
  }

  /**
   * Look up a custom field by exact name, creating it if missing. Returns
   * {fieldId, created}. Idempotent — safe to call on every boot.
   *
   * On creation the per-process custom-field-id cache is invalidated so the
   * new field resolves on the very next getCustomFieldIds() call (otherwise
   * PATCHes would emit paperless_unknown_custom_field warnings until the
   * cache TTL expired).
   */
  async ensureCustomField(name: string, dataType: string): Promise<{ fieldId: number; created: boolean }> {
    const data = await this.getJson<PaperlessListResponse<{ id: number; name: string }>>(
      "/api/custom_fields/",
      { name__iexact: name, page_size: 100 },
    );
    const existing = data.results.find((x) => x.name === name);
    if (existing !== undefined) return { fieldId: existing.id, created: false };

    const resp = await this.request("POST", "/api/custom_fields/", {
      json: { name, data_type: dataType },
    });
    if (resp.status >= 400) {
      const body = await resp.text();
      logger.error("paperless_create_field_rejected", { name, data_type: dataType, status: resp.status, body });
      raiseForStatus(resp, body);
    }
    const created = (await resp.json()) as { id: number };
    this.customFieldIdsCache = null;
    return { fieldId: created.id, created: true };
  }

  /**
   * Look up a tag by exact name, creating it if missing. Returns {tagId,
   * created}. Idempotent. `color` is the hex string Paperless stores as the
   * tag's display colour ("#22c55e" etc.); ignored on lookup (it doesn't
   * influence uniqueness).
   */
  async ensureTag(name: string, color?: string): Promise<{ tagId: number; created: boolean }> {
    const existing = await this.getTagId(name);
    if (existing !== null) return { tagId: existing, created: false };
    const body: Record<string, unknown> = { name };
    if (color) body["color"] = color;
    const resp = await this.request("POST", "/api/tags/", { json: body });
    if (resp.status >= 400) {
      const bodyText = await resp.text();
      logger.error("paperless_create_tag_rejected", { name, status: resp.status, body: bodyText });
      raiseForStatus(resp, bodyText);
    }
    const created = (await resp.json()) as { id: number };
    this.tagIdCache.delete(name);
    return { tagId: created.id, created: true };
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Look up an entity by exact name, creating it if missing. Works for any
   * Paperless endpoint whose entities are uniquely identified by `name`:
   * tags, correspondents, document_types. We use ?name__iexact= because the
   * bare ?name= parameter is silently ignored on /api/tags/ (it returns the
   * default first page regardless), so once the tag count passes one page
   * our exact-match check would not find the existing entity and POST would
   * trip the unique-name constraint with a 400. The equality re-check stays
   * as defence in depth.
   *
   * Race-tolerant: two propagator/extractor calls can both miss the cache
   * for the same correspondent name and both POST; the loser of the race
   * gets a 4xx from the unique-name constraint. On POST failure we re-GET
   * once — the parallel worker has just created the row by the time we look
   * again — and reuse its id instead of bubbling up an error that would tag
   * the doc ai-propagation-error.
   */
  private async getOrCreateNamed(endpoint: string, name: string): Promise<number> {
    const data = await this.getJson<PaperlessListResponse<{ id: number; name: string }>>(
      endpoint,
      { name__iexact: name },
    );
    const found = data.results.find((x) => x.name === name)?.id;
    if (found !== undefined) return found;

    const resp = await this.request("POST", endpoint, { json: { name } });
    if (resp.status >= 400) {
      // Most likely cause is a parallel create. Re-GET; if the row is now
      // visible, return its id and only log at info level.
      const retry = await this.request("GET", endpoint, { params: { name__iexact: name } });
      if (retry.ok) {
        const retryData = (await retry.json()) as PaperlessListResponse<{ id: number; name: string }>;
        const raced = retryData.results.find((x) => x.name === name)?.id;
        if (raced !== undefined) {
          logger.info("paperless_create_raced_resolved", { endpoint, name, id: raced });
          return raced;
        }
      }
      const body = await resp.text();
      logger.error("paperless_create_rejected", { endpoint, name, status: resp.status, body });
      raiseForStatus(resp, body);
    }
    const createdBody = (await resp.json()) as { id: number };
    // Invalidate the relevant caches so the freshly-created row is visible
    // to the next read in this process. Cheap: just drop the cache entry,
    // the next access repopulates.
    if (endpoint === "/api/tags/") this.tagIdCache.delete(name);
    this.entityNameMapCache.delete(endpoint);
    return createdBody.id;
  }

  async getTagId(name: string): Promise<number | null> {
    // See getOrCreateNamed for why we must use ?name__iexact= here.
    const cached = this.tagIdCache.get(name);
    if (cached && nowSeconds() - cached.when <= this.cacheTtlSeconds) {
      return cached.value;
    }
    const data = await this.getJson<PaperlessListResponse<{ id: number; name: string }>>(
      "/api/tags/",
      { name__iexact: name },
    );
    const tagId = data.results.find((t) => t.name === name)?.id ?? null;
    this.tagIdCache.set(name, { when: nowSeconds(), value: tagId });
    return tagId;
  }

  private async getCustomFieldIds(): Promise<Record<string, number>> {
    if (this.customFieldIdsCache && nowSeconds() - this.customFieldIdsCache.when <= this.cacheTtlSeconds) {
      return this.customFieldIdsCache.value;
    }
    const data = await this.getJson<PaperlessListResponse<{ id: number; name: string }>>(
      "/api/custom_fields/",
      { page_size: 100 },
    );
    const mapping: Record<string, number> = {};
    for (const f of data.results ?? []) mapping[f.name] = f.id;
    this.customFieldIdsCache = { when: nowSeconds(), value: mapping };
    return mapping;
  }
}
