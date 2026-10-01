export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60_000;

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = LOGIN_MAX_FAILURES,
    private readonly windowMs = LOGIN_WINDOW_MS,
  ) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  retryAfterSeconds(key: string, now = Date.now()): number | null {
    const recent = this.recent(key, now);
    if (recent.length < this.maxFailures) return null;
    const oldest = recent[0] as number;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  recordFailure(key: string, now = Date.now()): void {
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
