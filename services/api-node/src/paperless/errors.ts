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
