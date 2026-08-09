// Minimal structured logger. Mirrors the shape of structlog's key=value
// event logging used on the Python side (log.warning("event_name", k=v)) so
// log-scraping/alerting built against that convention keeps working.
type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", event: string, fields?: Fields): void {
  const line = { level, event, ...fields, timestamp: new Date().toISOString() };
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};
