export class PaperlessAuthError extends Error {
  constructor(public readonly status: number) {
    super(`Paperless rejected the API token (HTTP ${status})`);
    this.name = "PaperlessAuthError";
  }
}

export class PaperlessNotFoundError extends Error {
  constructor(public readonly docId: number) {
    super(`Paperless document ${docId} not found`);
    this.name = "PaperlessNotFoundError";
  }
}

export class PaperlessConflictError extends Error {
  constructor(public readonly docId: number) {
    super(`Paperless document ${docId} kept changing under us — concurrent writer`);
    this.name = "PaperlessConflictError";
  }
}

export class PaperlessRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`Paperless request failed: ${status} ${url}`);
    this.name = "PaperlessRequestError";
  }
}

/**
 * A tag the caller wants to add does not exist in Paperless, even after a
 * cache refresh. Raised instead of silently skipping it: the star toggle used
 * to answer 200 while nothing was written (2026-11-19).
 */
export class PaperlessUnknownTagError extends Error {
  constructor(public readonly names: string[]) {
    super(`Paperless has no tag named ${names.map((n) => `'${n}'`).join(", ")}`);
    this.name = "PaperlessUnknownTagError";
  }
}
