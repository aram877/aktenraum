import type {
  DocumentPermissions,
  OwnedEntity,
  PaperlessDocument,
  PaperlessGroup,
  PaperlessUser,
  SharedVocabularyEndpoint,
} from "../paperless/paperless.gateway.js";
import { PaperlessNotFoundError } from "../paperless/errors.js";

export const TAGS: Record<string, number> = {
  "ai-pending": 1,
  "ai-approved": 2,
  "ai-rejected": 3,
  "ai-propagated": 4,
  "ai-low-confidence": 5,
  "ai-auto-approved": 6,
  wichtig: 7,
  Versicherung: 8,
  "ai-duplicate": 20,
  "ai-duplicate-dismissed": 21,
  "ai-error": 30,
  "ai-propagation-error": 31,
};

export const CUSTOM_FIELDS: Record<string, number> = {
  ai_correspondent: 10,
  ai_document_type: 11,
  ai_title: 12,
  ai_issue_date: 13,
  ai_confidence: 14,
  ai_summary_de: 15,
  ai_error_message: 16,
  ai_reference_numbers: 17,
};

export const CORRESPONDENTS: Record<string, number> = { "Stadtwerke München": 70 };
export const DOCUMENT_TYPES: Record<string, number> = { Rechnung: 80, Versicherung: 81 };

export function makeDoc(overrides: Partial<PaperlessDocument> = {}): PaperlessDocument {
  return {
    id: 42,
    title: "Rechnung Stadtwerke",
    original_file_name: "rechnung.pdf",
    created_date: "2026-03-15",
    added: "2026-03-16T10:00:00Z",
    content: "Sehr geehrte Damen und Herren",
    correspondent: 70,
    document_type: 80,
    tags: [TAGS["ai-pending"] as number, TAGS.wichtig as number],
    custom_fields: [
      { field: 10, value: "Stadtwerke München" },
      { field: 11, value: "Rechnung" },
      { field: 15, value: "Eine Stromrechnung." },
    ],
    ...overrides,
  };
}

export interface FakeGatewayOptions {
  docs?: PaperlessDocument[];
  trashed?: PaperlessDocument[];
  tasks?: Record<string, unknown>[];
  processedMail?: Record<string, unknown>[];
}

function idList(raw: unknown): number[] {
  if (raw === undefined || raw === null || raw === "") return [];
  return String(raw).split(",").map(Number);
}

export class FakeGateway {
  readonly docs = new Map<number, PaperlessDocument>();
  readonly trashed = new Map<number, PaperlessDocument>();
  readonly uploads: { filename: string; contentType?: string }[] = [];
  emptyTrashCalls: number[][] = [];
  readonly tasks: Record<string, unknown>[];
  readonly processedMail: Record<string, unknown>[];
  /** Doc ids whose tag PATCH fails, to exercise per-document error paths. */
  readonly failTagPatchFor = new Set<number>();
  tasksError: Error | null = null;

  constructor(options: FakeGatewayOptions = {}) {
    for (const doc of options.docs ?? [makeDoc()]) this.docs.set(doc.id, doc);
    for (const doc of options.trashed ?? []) this.trashed.set(doc.id, doc);
    this.tasks = options.tasks ?? [];
    this.processedMail = options.processedMail ?? [];
  }

  listConsumeTasks = async (): Promise<Record<string, unknown>[]> => {
    if (this.tasksError !== null) throw this.tasksError;
    return this.tasks;
  };

  listProcessedMail = async (): Promise<Record<string, unknown>[]> => this.processedMail;

  /** Paperless `/api/tasks/?task_id=` — an array, empty when unknown. */
  getTasks = async (taskId: string): Promise<unknown> => {
    this.taskLookups.push(taskId);
    return this.tasks.filter((t) => t.task_id === taskId);
  };
  readonly taskLookups: string[] = [];

  listCorrespondents = async (): Promise<Record<string, number>> => CORRESPONDENTS;
  listDocumentTypes = async (): Promise<Record<string, number>> => DOCUMENT_TYPES;
  listTags = async (): Promise<Record<string, number>> => TAGS;
  listDocumentTypeCounts = async (): Promise<{ name: string; count: number }[]> =>
    Object.entries(DOCUMENT_TYPES).map(([name, id]) => ({
      name,
      count: [...this.docs.values()].filter((d) => d.document_type === id).length,
    }));
  listTagsCovering = async (): Promise<Record<string, number>> => TAGS;
  getCustomFieldIds = async (): Promise<Record<string, number>> => CUSTOM_FIELDS;

  getDocument = async (docId: number): Promise<PaperlessDocument> => {
    const doc = this.docs.get(docId);
    if (doc === undefined) throw new PaperlessNotFoundError(docId);
    return doc;
  };

  searchDocuments = async (
    params: Record<string, unknown>,
    options: { pageSize?: number } = {},
  ): Promise<Record<string, unknown>> => {
    let results = [...this.docs.values()];
    const ids = idList(params.id__in);
    if (ids.length > 0) results = results.filter((d) => ids.includes(d.id));
    const anyOf = idList(params.tags__id__in);
    if (anyOf.length > 0) {
      results = results.filter((d) => ((d.tags as number[]) ?? []).some((t) => anyOf.includes(t)));
    }
    const docType = params.document_type__id;
    if (docType !== undefined) {
      results = results.filter((d) => d.document_type === Number(docType));
    }
    const only = params.tags__id;
    if (only !== undefined) {
      results = results.filter((d) => ((d.tags as number[]) ?? []).includes(Number(only)));
    }
    const none = idList(params.tags__id__none);
    if (none.length > 0) {
      results = results.filter((d) => !((d.tags as number[]) ?? []).some((t) => none.includes(t)));
    }
    const all = params.tags__id__all;
    if (typeof all === "string" && all !== "") {
      const wanted = all.split(",").map(Number);
      results = results.filter((d) =>
        wanted.every((t) => ((d.tags as number[]) ?? []).includes(t)),
      );
    }
    const count = results.length;
    if (options.pageSize !== undefined) results = results.slice(0, options.pageSize);
    return { count, results };
  };

  patchDocumentCustomFields = async (
    docId: number,
    nameToValue: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const doc = await this.getDocument(docId);
    const existing = (doc.custom_fields as { field: number; value: unknown }[]) ?? [];
    const byId = new Map(existing.map((cf) => [cf.field, cf.value]));
    for (const [name, value] of Object.entries(nameToValue)) {
      const fid = CUSTOM_FIELDS[name];
      if (fid !== undefined) byId.set(fid, value);
    }
    doc.custom_fields = [...byId.entries()].map(([field, value]) => ({ field, value }));
    return nameToValue;
  };

  swapLifecycleTag = async (
    docId: number,
    options: { remove: string[]; add: string[] },
  ): Promise<number[]> => {
    const doc = await this.getDocument(docId);
    if (this.failTagPatchFor.has(docId)) throw new Error(`Paperless rejected PATCH for ${docId}`);
    const removeIds = new Set(
      options.remove.map((name) => TAGS[name]).filter((id): id is number => id !== undefined),
    );
    const surviving = ((doc.tags as number[]) ?? []).filter((tid) => !removeIds.has(tid));
    for (const name of options.add) {
      const tid = TAGS[name];
      if (tid !== undefined && !surviving.includes(tid)) surviving.push(tid);
    }
    doc.tags = surviving;
    return surviving;
  };

  openDocumentStream = async (docId: number, kind: string): Promise<Response> => {
    await this.getDocument(docId);
    const headers: Record<string, string> = { "content-type": "application/pdf" };
    if (kind === "download") {
      headers["content-disposition"] = 'attachment; filename="rechnung.pdf"';
    }
    return new Response("%PDF-1.4 fake", { status: 200, headers });
  };

  uploadDocument = async (options: {
    content: Uint8Array;
    filename: string;
    contentType?: string;
  }): Promise<string> => {
    this.uploads.push({ filename: options.filename, contentType: options.contentType });
    return "task-uuid-1234";
  };

  deleteDocument = async (docId: number): Promise<void> => {
    const doc = await this.getDocument(docId);
    this.docs.delete(docId);
    this.trashed.set(docId, { ...doc, deleted_at: "2026-08-01T09:00:00Z" });
  };

  listTrashedDocuments = async (): Promise<Record<string, unknown>> => {
    const results = [...this.trashed.values()];
    return { count: results.length, next: null, results };
  };

  restoreDocuments = async (docIds: number[]): Promise<void> => {
    for (const id of docIds) {
      const doc = this.trashed.get(id);
      if (doc === undefined) throw new PaperlessNotFoundError(id);
      this.trashed.delete(id);
      this.docs.set(id, doc);
    }
  };

  emptyTrash = async (docIds: number[] | null): Promise<void> => {
    const ids = docIds && docIds.length > 0 ? docIds : [...this.trashed.keys()];
    this.emptyTrashCalls.push(ids);
    for (const id of ids) {
      if (!this.trashed.has(id)) throw new PaperlessNotFoundError(id);
      this.trashed.delete(id);
    }
  };

  ensureTag = async (name: string): Promise<number> => TAGS[name] ?? 99;

  // ---------------------------------------------------------------- tenancy mirror

  /** Paperless users by id; id 3 is the service superuser, as on the live install. */
  readonly users = new Map<number, PaperlessUser>([
    [3, { id: 3, username: "admin", groups: [], user_permissions: [], is_superuser: true }],
  ]);
  readonly groups = new Map<number, PaperlessGroup>();
  /** Owner + explicit permissions per document id; missing = superuser-owned, no grants. */
  readonly permissions = new Map<number, DocumentPermissions>();
  /** Shared-vocabulary entities with owners (tags, correspondents, document types). */
  readonly vocabulary: Record<SharedVocabularyEndpoint, OwnedEntity[]> = {
    "/api/tags/": Object.entries(TAGS).map(([name, id]) => ({ id, name, owner: 3 })),
    "/api/correspondents/": Object.entries(CORRESPONDENTS).map(([name, id]) => ({ id, name, owner: 3 })),
    "/api/document_types/": Object.entries(DOCUMENT_TYPES).map(([name, id]) => ({ id, name, owner: 3 })),
  };
  /** Every tenancy write, in order, so tests can assert idempotency. */
  readonly tenancyWrites: { op: string; target: number | string; payload?: unknown }[] = [];
  private nextUserId = 100;
  private nextGroupId = 500;

  private user(userId: number): PaperlessUser {
    const user = this.users.get(userId);
    if (user === undefined) throw new Error(`fake paperless: no user ${userId}`);
    return user;
  }

  findUserByUsername = async (username: string): Promise<PaperlessUser | null> =>
    [...this.users.values()].find((u) => u.username === username) ?? null;

  getUser = async (userId: number): Promise<PaperlessUser> => structuredClone(this.user(userId));

  createUser = async (options: {
    username: string;
    password: string;
    permissions: readonly string[];
  }): Promise<PaperlessUser> => {
    const user: PaperlessUser = {
      id: this.nextUserId++,
      username: options.username,
      groups: [],
      user_permissions: [...options.permissions],
      is_superuser: false,
    };
    this.users.set(user.id, user);
    this.tenancyWrites.push({ op: "createUser", target: options.username, payload: options.permissions });
    return structuredClone(user);
  };

  updateUser = async (
    userId: number,
    patch: { groups?: number[]; user_permissions?: readonly string[] },
  ): Promise<PaperlessUser> => {
    const user = this.user(userId);
    if (patch.groups !== undefined) user.groups = [...patch.groups];
    if (patch.user_permissions !== undefined) user.user_permissions = [...patch.user_permissions];
    this.tenancyWrites.push({ op: "updateUser", target: userId, payload: patch });
    return structuredClone(user);
  };

  findGroupByName = async (name: string): Promise<PaperlessGroup | null> =>
    [...this.groups.values()].find((g) => g.name === name) ?? null;

  createGroup = async (name: string): Promise<PaperlessGroup> => {
    const group = { id: this.nextGroupId++, name };
    this.groups.set(group.id, group);
    this.tenancyWrites.push({ op: "createGroup", target: name });
    return { ...group };
  };

  getDocumentPermissions = async (docId: number): Promise<DocumentPermissions> => {
    await this.getDocument(docId);
    return structuredClone(
      this.permissions.get(docId) ?? {
        owner: 3,
        permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } },
      },
    );
  };

  setDocumentPermissions = async (docId: number, target: DocumentPermissions): Promise<void> => {
    await this.getDocument(docId);
    this.permissions.set(docId, structuredClone(target));
    this.tenancyWrites.push({ op: "setDocumentPermissions", target: docId, payload: target });
  };

  bulkSetDocumentPermissions = async (docIds: number[], target: DocumentPermissions): Promise<void> => {
    for (const id of docIds) await this.getDocument(id);
    for (const id of docIds) this.permissions.set(id, structuredClone(target));
    this.tenancyWrites.push({ op: "bulkSetDocumentPermissions", target: docIds.join(","), payload: target });
  };

  listOwnedEntities = async (endpoint: SharedVocabularyEndpoint): Promise<OwnedEntity[]> =>
    this.vocabulary[endpoint].map((e) => ({ ...e }));

  clearOwner = async (endpoint: SharedVocabularyEndpoint, id: number): Promise<void> => {
    const entity = this.vocabulary[endpoint].find((e) => e.id === id);
    if (entity === undefined) throw new Error(`fake paperless: no ${endpoint}${id}`);
    entity.owner = null;
    this.tenancyWrites.push({ op: "clearOwner", target: `${endpoint}${id}` });
  };

  /** Last password set per user id (the fake's "login" checks it). */
  readonly passwords = new Map<number, string>();

  listDocumentPermissions = async (): Promise<Map<number, DocumentPermissions>> => {
    const out = new Map<number, DocumentPermissions>();
    for (const id of [...this.docs.keys()].sort((a, b) => a - b)) {
      out.set(id, await this.getDocumentPermissions(id));
    }
    return out;
  };

  setUserPassword = async (userId: number, password: string): Promise<void> => {
    this.user(userId);
    this.passwords.set(userId, password);
  };

  countDocumentsVisibleTo = async (username: string, password: string): Promise<number> => {
    const user = await this.findUserByUsername(username);
    if (user === null || this.passwords.get(user.id) !== password) {
      throw new Error("fake paperless: invalid credentials");
    }
    return this.visibleTo(user.id).length;
  };

  /** Documents a Paperless user can list: owner, or view via user/group grant. */
  visibleTo = (userId: number): number[] => {
    const user = this.user(userId);
    return [...this.docs.keys()].filter((id) => {
      if (user.is_superuser) return true;
      const perms = this.permissions.get(id);
      if (perms === undefined) return false;
      return (
        perms.owner === userId ||
        perms.permissions.view.users.includes(userId) ||
        perms.permissions.view.groups.some((g) => user.groups.includes(g))
      );
    });
  };
}
