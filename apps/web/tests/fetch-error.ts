export function fetchError(statusCode: number | undefined, data?: unknown, statusMessage?: string) {
  return Object.assign(new Error(`HTTP ${statusCode}`), {
    name: "FetchError",
    statusCode,
    statusMessage,
    data,
  });
}
