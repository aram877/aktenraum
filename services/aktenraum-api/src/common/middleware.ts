import { logger } from "@aktenraum/core";
import type { NextFunction, Request, Response } from "express";

const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const SAFE_SITE_VALUES: ReadonlySet<string> = new Set(["same-origin", "same-site", "none"]);

const PROTECTED_GET_SUFFIXES = ["/preview", "/download"] as const;

const CSRF_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/api/health",
  "/api/openapi.json",
  "/api/docs",
]);

function pathOf(request: Request): string {
  const raw = request.originalUrl || request.url;
  const queryStart = raw.indexOf("?");
  return queryStart === -1 ? raw : raw.slice(0, queryStart);
}

function endsWithProtectedSuffix(path: string): boolean {
  return PROTECTED_GET_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

export function needsCsrfCheck(method: string, path: string): boolean {
  if (CSRF_EXEMPT_PATHS.has(path)) return false;
  if (STATE_CHANGING_METHODS.has(method)) return true;
  if (method === "GET" && endsWithProtectedSuffix(path)) return true;
  return false;
}

export function isCsrfAllowed(options: {
  method: string;
  path: string;
  secFetchSite: string | undefined;
  hasInternalSecret: boolean;
}): boolean {
  if (!needsCsrfCheck(options.method, options.path)) return true;
  if (options.hasInternalSecret) return true;
  if (options.secFetchSite === undefined) return true;
  return SAFE_SITE_VALUES.has(options.secFetchSite);
}

export function csrfMiddleware(request: Request, response: Response, next: NextFunction): void {
  const path = pathOf(request);
  const secFetchSite = request.headers["sec-fetch-site"];
  const allowed = isCsrfAllowed({
    method: request.method,
    path,
    secFetchSite: typeof secFetchSite === "string" ? secFetchSite : undefined,
    hasInternalSecret: request.headers["x-aktenraum-secret"] !== undefined,
  });
  if (allowed) {
    next();
    return;
  }
  logger.warn("csrf_blocked", {
    path,
    method: request.method,
    sec_fetch_site: secFetchSite,
  });
  response.status(403).json({ detail: "Cross-site request blocked" });
}

export function securityHeadersMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const path = pathOf(request);
  if (!response.hasHeader("X-Content-Type-Options")) {
    response.setHeader("X-Content-Type-Options", "nosniff");
  }
  if (!endsWithProtectedSuffix(path) && !response.hasHeader("X-Frame-Options")) {
    response.setHeader("X-Frame-Options", "DENY");
  }
  if (!response.hasHeader("Referrer-Policy")) {
    response.setHeader("Referrer-Policy", "no-referrer");
  }
  next();
}
