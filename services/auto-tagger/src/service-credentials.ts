import { type ServiceCredentials } from "@aktenraum/core";

import type { Settings } from "./config.js";

/**
 * The credentials the worker verifies (`paperless-hook`, `api`) plus its own
 * (`worker`, sent to the api). The worker's own credential is part of the
 * verification map on purpose: a call that presents it is recognised and
 * refused with 403 rather than treated as unknown, and a value shared with
 * either other credential fails closed.
 */
export function workerServiceCredentials(
  settings: Pick<Settings, "SVC_TOKEN_PAPERLESS_HOOK" | "SVC_TOKEN_API" | "SVC_TOKEN_WORKER">,
): ServiceCredentials {
  return {
    "paperless-hook": settings.SVC_TOKEN_PAPERLESS_HOOK,
    worker: settings.SVC_TOKEN_WORKER,
    api: settings.SVC_TOKEN_API,
  };
}
