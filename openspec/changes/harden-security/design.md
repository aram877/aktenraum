## Decisions

**Password fingerprint instead of a token-version column.** `AuthGuard` already loads the user per request, so comparing a hash prefix of `password_hash` revokes sessions on password change without a schema migration (`applySchema` can't alter tables).

**In-memory login throttle.** One api process, one user base; a restart clearing the counters is acceptable. Keyed by username so the shared Tailscale/nginx source IP doesn't matter.

**Fail closed on an empty `WEBHOOK_SECRET`.** Every supported setup path generates one; an empty value is a misconfiguration and should not open internal endpoints.

**Disk-backed multer over hard limits.** The SPA sends all files in one request; a hard `fileSize` limit would abort the whole batch. Temp files keep memory bounded and keep per-file errors isolated.

**tar stream for files.** restic 0.16 and 0.18 both get EIO from `read(fd, buf, 524288)` on Docker Desktop's macOS bind mounts while C tools succeed; streaming a tar archive keeps content-defined dedup and works identically on macOS, Windows and Linux. Old snapshots stay for their retention; restore of new ones is `restic dump … | tar -x`.

**Backup keeps root.** busybox crond and reading files owned by several uids; `no-new-privileges` limits the blast radius.
