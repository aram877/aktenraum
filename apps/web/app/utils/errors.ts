interface FetchErrorLike {
  name: string;
  statusCode?: number;
  statusMessage?: string;
  data?: unknown;
}

function asFetchError(error: unknown): FetchErrorLike | null {
  if (error === null || typeof error !== "object") return null;
  if ((error as { name?: unknown }).name !== "FetchError") return null;
  return error as FetchErrorLike;
}

export function detailFrom(error: unknown, fallback: string): string {
  const fetchError = asFetchError(error);
  if (!fetchError) return fallback;
  const body = fetchError.data;
  const detail: unknown =
    body !== null && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const first: unknown = detail[0];
    if (first !== null && typeof first === "object" && "msg" in first) {
      return String((first as { msg: unknown }).msg);
    }
  }
  if (!fetchError.statusCode) return "Server nicht erreichbar.";
  return `${fetchError.statusCode} ${fetchError.statusMessage ?? ""}`.trim();
}

export function statusOf(error: unknown): number | null {
  return asFetchError(error)?.statusCode ?? null;
}
