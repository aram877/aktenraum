## Decisions

**Include snippet over duplication.** nginx's `add_header` inheritance is all-or-nothing per level; a shared include keeps the one CSP string in one file. The PDF preview location keeps its own `SAMEORIGIN` set so the SPA can frame it.

**Pin to running digests for stateful services.** The registry `postgres:15` / `redis:7` digests had moved past the running ones; pinning to the running digest makes the change a no-op for data, and the next bump is a deliberate step.

**No e2e in CI.** The worker e2e needs a local Ollama with a 14B model; GitHub runners can't host that. CI covers what is reproducible: compose validity, image builds, nginx syntax.

**Generous memory caps.** Caps bound a runaway, they are not reservations; 4g/2g leave headroom for OCR peaks while keeping one container from starving postgres.
