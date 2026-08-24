import { logger, normalizeDate, truncateForField } from "@aktenraum/core";

import {
  PaperlessAuthError,
  PaperlessConflictError,
  PaperlessNotFoundError,
  PaperlessRequestError,
} from "./errors.js";

const DATE_FIELDS: ReadonlySet<string> = new Set(["ai_issue_date"]);
const FLOAT_FIELDS: ReadonlySet<string> = new Set(["ai_confidence"]);

export type PaperlessDocument = Record<string, unknown> & { id: number };
export type CustomFieldEntry = { field: number; value: unknown };
export type QueryParams = Record<string, string | number | boolean | undefined | null>;

interface CacheEntry<T> {
  when: number;
  value: T;
}

export interface PaperlessGatewayOptions {
  ttlSeconds?: number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

export function normaliseFieldValues(
  nameToValue: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(nameToValue)) {
    if (value === null || value === undefined) {
      out[name] = null;
      continue;
    }
    if (DATE_FIELDS.has(name)) {
      out[name] = normalizeDate(String(value));
      continue;
    }
    if (FLOAT_FIELDS.has(name)) {
      out[name] = value;
      continue;
    }
    if (typeof value === "string") {
      out[name] = truncateForField(name, value);
      continue;
    }
    out[name] = value;
  }
  return out;
}

export function mergeCustomFields(
  existing: CustomFieldEntry[],
  updateById: Map<number, unknown>,
): CustomFieldEntry[] {
  const seen = new Set<number>();
  const merged: CustomFieldEntry[] = [];
  for (const cf of existing) {
    const fid = cf.field;
    if (fid === null || fid === undefined) continue;
    if (updateById.has(fid)) {
      merged.push({ field: fid, value: updateById.get(fid) });
      seen.add(fid);
    } else {
      merged.push({ field: fid, value: cf.value });
    }
  }
  for (const [fid, value] of updateById) {
    if (!seen.has(fid)) merged.push({ field: fid, value });
  }
  return merged;
}

export function planTagSwap(options: {
  currentIds: number[];
  nameToId: Record<string, number>;
  remove: string[];
  add: string[];
}): number[] {
  const removeIds = new Set(
    options.remove
      .map((name) => options.nameToId[name])
      .filter((id): id is number => id !== undefined),
  );
  const surviving = options.currentIds.filter((tid) => !removeIds.has(tid));
  const seen = new Set(surviving);
  for (const name of options.add) {
    const tid = options.nameToId[name];
    if (tid === undefined || seen.has(tid)) continue;
    surviving.push(tid);
    seen.add(tid);
  }
  return surviving;
}

export class PaperlessGateway {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly ttlSeconds: number;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  private correspondentsCache: CacheEntry<Record<string, number>> | null = null;
  private documentTypesCache: CacheEntry<Record<string, number>> | null = null;
  private tagsCache: CacheEntry<Record<string, number>> | null = null;
  private customFieldIdsCache: CacheEntry<Record<string, number>> | null = null;

  constructor(baseUrl: string, apiToken: string, options: PaperlessGatewayOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.headers = { Authorization: `Token ${apiToken}` };
    this.ttlSeconds = options.ttlSeconds ?? 300;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private buildUrl(path: string, params?: QueryParams): string {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request(
    method: string,
    path: string,
    options: { params?: QueryParams; json?: unknown; body?: FormData; stream?: boolean } = {},
  ): Promise<Response> {
    const url = this.buildUrl(path, options.params);
    const init: RequestInit = { method, headers: { ...this.headers } };
    if (options.json !== undefined) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
      init.body = options.body;
    }
    if (options.stream === true) {
      return this.fetchFn(url, init);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private raiseAuth(resp: Response): void {
    if (resp.status === 401 || resp.status === 403) {
      throw new PaperlessAuthError(resp.status);
    }
  }

  private async raiseForStatus(resp: Response): Promise<void> {
    if (resp.status >= 400) {
      throw new PaperlessRequestError(resp.status, await resp.text(), resp.url);
    }
  }

  private readCache<T>(entry: CacheEntry<T> | null): T | null {
    if (entry === null) return null;
    if (nowSeconds() - entry.when > this.ttlSeconds) return null;
    return entry.value;
  }

  private async listNamed(endpoint: string): Promise<Record<string, number>> {
    const resp = await this.request("GET", endpoint, { params: { page_size: 200 } });
    this.raiseAuth(resp);
    await this.raiseForStatus(resp);
    const payload = (await resp.json()) as { results?: { name: string; id: number }[] };
    const mapping: Record<string, number> = {};
    for (const entry of payload.results ?? []) mapping[entry.name] = entry.id;
    return mapping;
  }

  async listCorrespondents(): Promise<Record<string, number>> {
    const cached = this.readCache(this.correspondentsCache);
    if (cached !== null) return cached;
    const mapping = await this.listNamed("/api/correspondents/");
    this.correspondentsCache = { when: nowSeconds(), value: mapping };
    return mapping;
  }

  async listDocumentTypes(): Promise<Record<string, number>> {
    const cached = this.readCache(this.documentTypesCache);
    if (cached !== null) return cached;
    const mapping = await this.listNamed("/api/document_types/");
    this.documentTypesCache = { when: nowSeconds(), value: mapping };
    return mapping;
  }

  async listTags(): Promise<Record<string, number>> {
    const cached = this.readCache(this.tagsCache);
    if (cached !== null) return cached;
    const mapping = await this.listNamed("/api/tags/");
    this.tagsCache = { when: nowSeconds(), value: mapping };
    return mapping;
  }

  invalidateTagCache(): void {
    this.tagsCache = null;
  }

  /**
   * Tag name→id map guaranteed to cover `ids`, refetching once if it doesn't.
   *
   * The propagator creates tags from inside the auto-tagger — a separate
   * process — so this gateway's 300s cache can predate them. Without the
   * refetch, every projection that resolves a tag id to a name silently drops
   * the ones it cannot resolve, and a freshly-approved document appears in the
   * Library with its new tags missing until the TTL lapses. One-shot by
   * design: a genuinely deleted tag must not cause a refetch on every request.
   */
  async listTagsCovering(ids: Iterable<number>): Promise<Record<string, number>> {
    const mapping = await this.listTags();
    const known = new Set(Object.values(mapping));
    for (const id of ids) {
      if (!known.has(id)) {
        this.invalidateTagCache();
        logger.info("paperless_tag_cache_refreshed", { unknown_tag_id: id });
        return this.listTags();
      }
    }
    return mapping;
  }

  async ensureTag(name: string): Promise<number> {
    const tags = await this.listTags();
    const known = tags[name];
    if (known !== undefined) return known;

    const lookup = await this.request("GET", "/api/tags/", { params: { name__iexact: name } });
    this.raiseAuth(lookup);
    if (lookup.status < 400) {
      const payload = (await lookup.json()) as { results?: { name: string; id: number }[] };
      const found = (payload.results ?? []).find((entry) => entry.name === name);
      if (found !== undefined) {
        this.tagsCache = null;
        return found.id;
      }
    }

    const created = await this.request("POST", "/api/tags/", { json: { name } });
    this.raiseAuth(created);
    if (created.status >= 400) {
      const retry = await this.request("GET", "/api/tags/", { params: { name__iexact: name } });
      if (retry.status < 400) {
        const payload = (await retry.json()) as { results?: { name: string; id: number }[] };
        const raced = (payload.results ?? []).find((entry) => entry.name === name);
        if (raced !== undefined) {
          this.tagsCache = null;
          return raced.id;
        }
      }
      const body = await created.text();
      logger.error("paperless_create_tag_rejected", { name, status: created.status, body });
      throw new PaperlessRequestError(created.status, body, created.url);
    }
    this.tagsCache = null;
    const payload = (await created.json()) as { id: number };
    return payload.id;
  }

  async getDocument(docId: number): Promise<PaperlessDocument> {
    const resp = await this.request("GET", `/api/documents/${docId}/`);
    if (resp.status === 404) throw new PaperlessNotFoundError(docId);
    this.raiseAuth(resp);
    await this.raiseForStatus(resp);
    return (await resp.json()) as PaperlessDocument;
  }

  async patchDocumentCustomFields(
    docId: number,
    nameToValue: Record<string, unknown>,
    options: { prefetchedDoc?: PaperlessDocument } = {},
  ): Promise<Record<string, unknown>> {
    if (Object.keys(nameToValue).length === 0) return {};
    const normalised = normaliseFieldValues(nameToValue);
    let fieldIds = await this.getCustomFieldIds();

    const updateById = new Map<number, unknown>();
    let retried = false;
    for (const [name, value] of Object.entries(normalised)) {
      let fid = fieldIds[name];
      if (fid === undefined && !retried) {
        this.customFieldIdsCache = null;
        fieldIds = await this.getCustomFieldIds();
        retried = true;
        fid = fieldIds[name];
      }
      if (fid === undefined) {
        logger.warn("paperless_unknown_custom_field", { name });
        continue;
      }
      updateById.set(fid, value);
    }
    if (updateById.size === 0) return normalised;

    const existing = options.prefetchedDoc ?? (await this.getDocument(docId));
    const merged = mergeCustomFields(
      (existing.custom_fields as CustomFieldEntry[] | undefined) ?? [],
      updateById,
    );
    const resp = await this.request("PATCH", `/api/documents/${docId}/`, {
      json: { custom_fields: merged },
    });
    if (resp.status === 404) throw new PaperlessNotFoundError(docId);
    this.raiseAuth(resp);
    if (resp.status >= 400) {
      const body = await resp.text();
      logger.error("paperless_patch_rejected", { doc_id: docId, status: resp.status, body });
      throw new PaperlessRequestError(resp.status, body, resp.url);
    }
    return normalised;
  }

  async swapLifecycleTag(
    docId: number,
    options: { remove: string[]; add: string[] },
  ): Promise<number[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const doc = await this.getDocument(docId);
      const currentIds = (doc.tags as number[] | undefined) ?? [];
      const nameToId = await this.listTags();
      const newIds = planTagSwap({
        currentIds,
        nameToId,
        remove: options.remove,
        add: options.add,
      });
      if (
        newIds.length === currentIds.length &&
        newIds.every((id, index) => id === currentIds[index])
      ) {
        return currentIds;
      }
      const resp = await this.request("PATCH", `/api/documents/${docId}/`, {
        json: { tags: newIds },
      });
      if (resp.status === 404) throw new PaperlessNotFoundError(docId);
      this.raiseAuth(resp);
      if (resp.status >= 400) {
        const body = await resp.text();
        logger.error("paperless_patch_rejected", { doc_id: docId, status: resp.status, body });
        throw new PaperlessRequestError(resp.status, body, resp.url);
      }

      const verify = await this.getDocument(docId);
      const verifiedIds = (verify.tags as number[] | undefined) ?? [];
      const planned = new Set(newIds);
      if (verifiedIds.length === planned.size && verifiedIds.every((id) => planned.has(id))) {
        return newIds;
      }
      logger.warn("lifecycle_tag_swap_raced", {
        doc_id: docId,
        attempt: attempt + 1,
        planned: newIds,
        observed: verifiedIds,
      });
    }
    throw new PaperlessConflictError(docId);
  }

  async openDocumentStream(docId: number, kind: string): Promise<Response> {
    if (kind !== "preview" && kind !== "download" && kind !== "thumb") {
      throw new Error(`Unknown document stream kind: ${JSON.stringify(kind)}`);
    }
    const resp = await this.request("GET", `/api/documents/${docId}/${kind}/`, { stream: true });
    if (resp.status === 404) throw new PaperlessNotFoundError(docId);
    if (resp.status === 401 || resp.status === 403) {
      throw new PaperlessAuthError(resp.status);
    }
    if (resp.status >= 400) {
      throw new PaperlessRequestError(resp.status, await resp.text(), resp.url);
    }
    return resp;
  }

  async uploadDocument(options: {
    content: Uint8Array;
    filename: string;
    contentType?: string;
    title?: string;
  }): Promise<string> {
    const form = new FormData();
    const blob = new Blob([options.content], {
      type: options.contentType ?? "application/octet-stream",
    });
    form.append("document", blob, options.filename);
    if (options.title) form.append("title", options.title);

    const resp = await this.request("POST", "/api/documents/post_document/", { body: form });
    this.raiseAuth(resp);
    if (resp.status >= 400) {
      const body = await resp.text();
      logger.error("paperless_upload_rejected", {
        status: resp.status,
        filename: options.filename,
        body,
      });
      throw new PaperlessRequestError(resp.status, body, resp.url);
    }
    return (await resp.text()).trim().replace(/^"|"$/g, "");
  }

  async deleteDocument(docId: number): Promise<void> {
    const resp = await this.request("DELETE", `/api/documents/${docId}/`);
    if (resp.status === 404) throw new PaperlessNotFoundError(docId);
    this.raiseAuth(resp);
    if (resp.status >= 400) {
      const body = await resp.text();
      logger.error("paperless_delete_rejected", { doc_id: docId, status: resp.status, body });
      throw new PaperlessRequestError(resp.status, body, resp.url);
    }
  }

  async listTrashedDocuments(
    options: { page?: number; pageSize?: number; ordering?: string } = {},
  ): Promise<Record<string, unknown>> {
    const resp = await this.request("GET", "/api/trash/", {
      params: {
        page: options.page ?? 1,
        page_size: options.pageSize ?? 20,
        ordering: options.ordering,
      },
    });
    this.raiseAuth(resp);
    if (resp.status >= 400) {
      const body = await resp.text();
      logger.error("paperless_trash_list_rejected", {
        status: resp.status,
        body: body.slice(0, 300),
      });
      throw new PaperlessRequestError(resp.status, body, resp.url);
    }
    return (await resp.json()) as Record<string, unknown>;
  }

  async restoreDocuments(docIds: number[]): Promise<void> {
    if (docIds.length === 0) return;
    const resp = await this.request("POST", "/api/trash/", {
      json: { documents: docIds, action: "restore" },
    });
    if (resp.status === 404) {
      throw new PaperlessNotFoundError(docIds.length === 1 ? (docIds[0] as number) : 0);
    }
    this.raiseAuth(resp);
    if (resp.status >= 400) {
      const body = await resp.text();
      logger.error("paperless_trash_restore_rejected", {
        doc_ids: docIds,
        status: resp.status,
        body: body.slice(0, 300),
      });
      throw new PaperlessRequestError(resp.status, body, resp.url);
    }
  }

  async emptyTrash(docIds: number[] | null = null): Promise<void> {
    const resp = await this.request("POST", "/api/trash/", {
      json: { documents: docIds ?? [], action: "empty" },
    });
    if (resp.status === 404) {
      throw new PaperlessNotFoundError(docIds && docIds.length > 0 ? (docIds[0] as number) : 0);
    }
    this.raiseAuth(resp);
    if (resp.status >= 400) {
      const body = await resp.text();
      logger.error("paperless_trash_empty_rejected", {
        doc_ids: docIds,
        status: resp.status,
        body: body.slice(0, 300),
      });
      throw new PaperlessRequestError(resp.status, body, resp.url);
    }
  }

  async getCustomFieldIds(): Promise<Record<string, number>> {
    const cached = this.readCache(this.customFieldIdsCache);
    if (cached !== null) return cached;
    const resp = await this.request("GET", "/api/custom_fields/", { params: { page_size: 100 } });
    this.raiseAuth(resp);
    await this.raiseForStatus(resp);
    const payload = (await resp.json()) as { results?: { name: string; id: number }[] };
    const mapping: Record<string, number> = {};
    for (const entry of payload.results ?? []) mapping[entry.name] = entry.id;
    this.customFieldIdsCache = { when: nowSeconds(), value: mapping };
    return mapping;
  }

  async getTasks(taskId: string): Promise<unknown> {
    const resp = await this.request("GET", "/api/tasks/", { params: { task_id: taskId } });
    this.raiseAuth(resp);
    await this.raiseForStatus(resp);
    return resp.json();
  }

  async searchDocuments(
    params: QueryParams,
    options: { pageSize?: number } = {},
  ): Promise<Record<string, unknown>> {
    const resp = await this.request("GET", "/api/documents/", {
      params: { page_size: options.pageSize ?? 100, ...params },
    });
    if (resp.status === 401 || resp.status === 403) {
      logger.error("paperless_auth_rejected", { status: resp.status });
      throw new PaperlessAuthError(resp.status);
    }
    await this.raiseForStatus(resp);
    return (await resp.json()) as Record<string, unknown>;
  }
}
