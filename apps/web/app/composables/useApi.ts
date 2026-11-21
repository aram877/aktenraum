export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  upload<T>(path: string, form: FormData): Promise<T>;
  del<T>(path: string): Promise<T>;
}

/**
 * The one HTTP client of the SPA. Sensitive actions answer 403
 * `step_up_required` (auth-passkeys §9): the request is repeated once after a
 * passkey confirmation. 403 `enrolment_required` sends the router to /enrol.
 */
export function useApi(): ApiClient {
  const request = $fetch.create({ baseURL: "/api", credentials: "include" });
  const post = <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: "POST", body: (body ?? {}) as Record<string, unknown> });
  const guarded = <T>(run: () => Promise<T>): Promise<T> =>
    withStepUp(run, () => confirmWithPasskey(post), () => void navigateTo("/enrol"));
  return {
    get: (path) => guarded(() => request(path, { method: "GET" })),
    post: (path, body) => guarded(() => post(path, body)),
    patch: (path, body) => guarded(() => request(path, { method: "PATCH", body: body as Record<string, unknown> })),
    put: (path, body) => guarded(() => request(path, { method: "PUT", body: body as Record<string, unknown> })),
    upload: (path, form) => guarded(() => request(path, { method: "POST", body: form })),
    del: (path) => guarded(() => request(path, { method: "DELETE" })),
  };
}
