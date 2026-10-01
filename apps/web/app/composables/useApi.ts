export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  upload<T>(path: string, form: FormData): Promise<T>;
}

export function useApi(): ApiClient {
  const request = $fetch.create({ baseURL: "/api", credentials: "include" });
  return {
    get: (path) => request(path, { method: "GET" }),
    post: (path, body) => request(path, { method: "POST", body: (body ?? {}) as Record<string, unknown> }),
    patch: (path, body) => request(path, { method: "PATCH", body: body as Record<string, unknown> }),
    put: (path, body) => request(path, { method: "PUT", body: body as Record<string, unknown> }),
    upload: (path, form) => request(path, { method: "POST", body: form }),
  };
}
