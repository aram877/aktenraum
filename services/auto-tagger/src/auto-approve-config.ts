import { DOCUMENT_TYPES, logger, type DocumentType } from "@aktenraum/core";

import type { RuleSet } from "./routing.js";

const CACHE_TTL_SECONDS = 60;

interface WireRule {
  document_type: string;
  enabled: boolean;
  min_confidence: number | string | null;
}

export function buildFailClosedRuleSet(): RuleSet {
  const byType = new Map<DocumentType, { documentType: DocumentType; enabled: boolean; minConfidence: number }>();
  for (const type of DOCUMENT_TYPES) {
    byType.set(type, { documentType: type, enabled: false, minConfidence: 1 });
  }
  return { byType, failClosed: true };
}

export function parseRuleSet(rules: readonly WireRule[]): RuleSet {
  const known = new Set<string>(DOCUMENT_TYPES);
  const byType = new Map<DocumentType, { documentType: DocumentType; enabled: boolean; minConfidence: number }>();
  for (const rule of rules) {
    if (!known.has(rule.document_type)) continue;
    const type = rule.document_type as DocumentType;
    const minConfidence =
      typeof rule.min_confidence === "number" ? rule.min_confidence : Number(rule.min_confidence ?? NaN);
    const valid = Number.isFinite(minConfidence);
    byType.set(type, {
      documentType: type,
      enabled: Boolean(rule.enabled) && valid,
      minConfidence: valid ? minConfidence : 1,
    });
  }
  return { byType, failClosed: false };
}

export class AutoApproveConfig {
  private cache: RuleSet | null = null;
  private loadedAt = 0;
  private inFlight: Promise<RuleSet> | null = null;

  constructor(
    private readonly apiUrl: string,
    private readonly webhookSecret: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async getRules(now: number = Date.now() / 1000): Promise<RuleSet> {
    if (this.cache !== null && now - this.loadedAt <= CACHE_TTL_SECONDS) return this.cache;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.load(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(now: number): Promise<RuleSet> {
    if (!this.apiUrl) return this.fallback("api_url_unset");
    const headers: Record<string, string> = {};
    if (this.webhookSecret) headers["X-Aktenraum-Secret"] = this.webhookSecret;
    const url = `${this.apiUrl.replace(/\/+$/, "")}/api/settings/active-auto-approve-rules`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const resp = await this.fetchFn(url, { headers, signal: controller.signal });
      if (!resp.ok) return this.fallback(`status_${resp.status}`);
      const payload = (await resp.json()) as { rules?: WireRule[] };
      const ruleSet = parseRuleSet(payload.rules ?? []);
      this.cache = ruleSet;
      this.loadedAt = now;
      return ruleSet;
    } catch (error: unknown) {
      return this.fallback(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reuse a warm cache when the rule store blips, but fail CLOSED on a cold
   * start: with no cache yet, every document routes to pending rather than
   * silently auto-approving under defaults the operator never chose.
   */
  private fallback(reason: string): RuleSet {
    if (this.cache !== null) {
      logger.warn("auto_approve_rules_unreachable_using_cache", { reason });
      return this.cache;
    }
    logger.warn("auto_approve_rules_unreachable_fail_closed", { reason });
    return buildFailClosedRuleSet();
  }
}
