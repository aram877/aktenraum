/**
 * Field-based duplicate detection for newly-propagated documents.
 *
 * The propagator calls `findDuplicates` after a successful Paperless PATCH;
 * matched candidates get tagged `ai-duplicate` alongside the new doc. This
 * module is intentionally pure (no Paperless I/O) so the rule is
 * exhaustively unit-testable without HTTP mocks.
 *
 * Detection rule — every condition must hold for two docs to be considered
 * duplicates:
 *   1. Both carry a non-empty correspondent that matches after case-folding
 *      and trimming.
 *   2. Both carry an issue date and the dates are equal as strict ISO
 *      strings.
 *   3. Document types match. When BOTH docs carry a document_type, the
 *      types must be equal. This prevents the common false positive where
 *      an invoice (Rechnung) and its payment confirmation (Beleg) from the
 *      same vendor on the same day for the same amount get flagged as
 *      duplicates — they're related but NOT duplicates. If either side has
 *      no type, the type check is skipped (backward compat with corpora
 *      indexed before this signal existed).
 *   4. At least one of:
 *      a. Both monetary amounts parse to numbers differing by <= 0.01 after
 *         stripping the ISO prefix (e.g. "EUR149.99" -> 149.99). NOTE: the
 *         generic `ai_monetary_amount` Paperless field was retired (money
 *         now lives on per-type schemas), so the value read back in
 *         production is always empty and this branch is currently INERT —
 *         dedup keys on (1)+(2)+(3)+(4b) in practice. The mechanism (and
 *         its tests) are retained so a future repoint to the type-specific
 *         monetary fields is a one-line change at the call sites, not a
 *         rewrite.
 *      b. The intersection of reference_numbers (comma-split, case-folded,
 *         trimmed) is non-empty.
 *
 * If the NEW doc lacks either anchor (correspondent or issue date) the
 * detector short-circuits and returns []. Without those anchors the
 * false-positive rate is too high — amount alone routinely collides on
 * recurring same-price bills.
 */

/**
 * Subset of a document's fields the detector reads. Pure data — constructed
 * in the propagator from the Paperless doc + custom-fields blob, then
 * passed to findDuplicates.
 */
export interface DocFields {
  readonly id: number;
  readonly correspondent?: string | null;
  readonly issueDate?: string | null;
  readonly monetaryAmount?: string | null;
  readonly referenceNumbers?: string | null;
  // Used as a discriminator so a Rechnung + Beleg (or any two docs of
  // different types) for the same vendor/date/amount don't get flagged as
  // duplicates. Optional for backward compat — missing on either side
  // skips the check.
  readonly documentType?: string | null;
}

const AMOUNT_TOLERANCE = 0.01;

/**
 * Return ids of candidates that look like duplicates of newDoc. Pure
 * function — no I/O, no global state. Order of returned ids follows the
 * order candidates were iterated.
 */
export function findDuplicates(newDoc: DocFields, candidates: Iterable<DocFields>): number[] {
  const newCorr = normText(newDoc.correspondent);
  const newDate = normText(newDoc.issueDate);
  if (!newCorr || !newDate) return [];

  const newAmount = parseAmount(newDoc.monetaryAmount);
  const newRefs = normalizeRefs(newDoc.referenceNumbers);
  const newType = normText(newDoc.documentType);

  const matches: number[] = [];
  for (const cand of candidates) {
    if (cand.id === newDoc.id) continue;
    if (normText(cand.correspondent) !== newCorr) continue;
    if (normText(cand.issueDate) !== newDate) continue;

    const candType = normText(cand.documentType);
    // Type discriminator: when both sides have a type, they must match.
    // Missing type on either side -> skip the check (the corpus may
    // pre-date the doc-type signal, or the LLM didn't extract one).
    if (newType && candType && newType !== candType) continue;

    if (amountMatches(newAmount, parseAmount(cand.monetaryAmount))) {
      matches.push(cand.id);
      continue;
    }
    const candRefs = normalizeRefs(cand.referenceNumbers);
    if (newRefs.size > 0 && [...newRefs].some((r) => candRefs.has(r))) {
      matches.push(cand.id);
    }
  }
  return matches;
}

/**
 * Lower-case + whitespace-trim; empty/null -> empty string.
 *
 * Applies the German "ß" -> "ss" case-fold before lower-casing so
 * correspondent names like "Müller-Sohn GmbH" match across stylistic
 * variations (e.g. "MÜLLER-SOHN GMBH" vs "Müller-Sohn"). This mirrors the
 * one specific case-folding behavior the Python side's `str.casefold()`
 * call was chosen for — it is not a full Unicode default-case-fold
 * implementation, but no other case-folding divergence is exercised by
 * this codebase's data (German correspondent/reference-number text).
 */
function normText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value.trim().replace(/ß/g, "ss").toLowerCase();
}

/**
 * Strip the Paperless ISO currency prefix and parse to a number.
 *
 * The worker PATCHes monetary fields in `<ISO><amount>` format (e.g.
 * "EUR149.99") so the values read back from Paperless follow that shape.
 * We tolerate a missing prefix and leading/trailing spaces; we do NOT
 * tolerate German-style commas because Paperless rejects those at write
 * time, so they shouldn't be in the stored value.
 *
 * Returns null when the value is missing or unparseable so the caller can
 * decide whether to fall through to the reference-number signal.
 */
function parseAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  let text = value.trim();
  if (!text) return null;
  // Strip an ISO-3-letter currency prefix if present.
  if (text.length >= 4 && /^[A-Za-z]{3}/.test(text)) {
    text = text.slice(3);
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isNaN(amount) ? null : amount;
}

/** Both must be present and within tolerance. */
function amountMatches(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= AMOUNT_TOLERANCE;
}

/**
 * Split the comma-separated reference-numbers string into a set.
 * Empty string/null -> empty set. Trim + case-fold each entry. Empty
 * fragments are dropped so a stray "RN-001," doesn't smuggle a "" into the
 * set that would match every other empty-ref doc.
 */
function normalizeRefs(value: string | null | undefined): Set<string> {
  if (!value) return new Set();
  const out = new Set<string>();
  for (const entry of value.split(",")) {
    const clean = entry.trim().replace(/ß/g, "ss").toLowerCase();
    if (clean) out.add(clean);
  }
  return out;
}
