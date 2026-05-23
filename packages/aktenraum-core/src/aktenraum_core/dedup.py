"""Field-based duplicate detection for newly-propagated documents.

The propagator calls `find_duplicates` after a successful Paperless
PATCH; matched candidates get tagged `ai-duplicate` alongside the new
doc. This module is intentionally pure (no Paperless I/O) so the rule
is exhaustively unit-testable without HTTP mocks.

v1 detection rule — every condition must hold for two docs to be
considered duplicates:
  1. Both carry a non-empty `ai_correspondent` that matches after
     Unicode case-folding and trimming.
  2. Both carry an `ai_issue_date` and the dates are equal as strict
     ISO strings.
  3. At least one of:
     a. Both `ai_monetary_amount` values exist and parse to numbers
        differing by ≤ 0.01 after stripping the Paperless ISO prefix
        (e.g. `EUR149.99` → 149.99).
     b. The intersection of `ai_reference_numbers` (comma-split,
        case-folded, trimmed) is non-empty.

If the NEW doc lacks either anchor (correspondent or issue_date) the
detector short-circuits and returns `[]`. Without those anchors the
false-positive rate is too high — amount alone routinely collides on
recurring same-price bills.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True)
class DocFields:
    """Subset of a document's fields the detector reads.

    Pure data — constructed in the propagator from the Paperless doc +
    custom-fields blob, then passed to `find_duplicates`. Keeping the
    propagator-to-detector contract narrow makes the rule easy to
    extend in v2 without churning the call site.
    """

    id: int
    correspondent: str | None = None
    issue_date: str | None = None
    monetary_amount: str | None = None
    reference_numbers: str | None = None


_AMOUNT_TOLERANCE = 0.01


def find_duplicates(
    new_doc: DocFields, candidates: Iterable[DocFields]
) -> list[int]:
    """Return ids of candidates that look like duplicates of new_doc.

    Pure function — no I/O, no global state. Order of returned ids
    follows the order candidates were yielded.
    """
    new_corr = _norm_text(new_doc.correspondent)
    new_date = _norm_text(new_doc.issue_date)
    if not new_corr or not new_date:
        return []

    new_amount = _parse_amount(new_doc.monetary_amount)
    new_refs = _normalize_refs(new_doc.reference_numbers)

    matches: list[int] = []
    for cand in candidates:
        if cand.id == new_doc.id:
            continue
        if _norm_text(cand.correspondent) != new_corr:
            continue
        if _norm_text(cand.issue_date) != new_date:
            continue
        if _amount_matches(new_amount, _parse_amount(cand.monetary_amount)):
            matches.append(cand.id)
            continue
        cand_refs = _normalize_refs(cand.reference_numbers)
        if new_refs and (new_refs & cand_refs):
            matches.append(cand.id)
    return matches


def _norm_text(value: str | None) -> str:
    """Lower-case + whitespace-trim; empty / None → empty string.

    Uses `casefold()` instead of `lower()` so e.g. German "ß" → "ss"
    matches "SS" — important for correspondent names like "Müller-
    Sohn GmbH" written with stylistic variations across receipts.
    """
    if value is None:
        return ""
    return value.strip().casefold()


def _parse_amount(value: str | None) -> float | None:
    """Strip the Paperless ISO currency prefix and parse to float.

    The auto-tagger PATCHes monetary fields in `<ISO><amount>` format
    (e.g. `EUR149.99`) so the values we read back from Paperless follow
    that shape. We tolerate missing prefix and leading/trailing spaces;
    we do NOT tolerate German-style commas because Paperless rejects
    those at write time, so they shouldn't be in the stored value.

    Returns None when the value is missing or unparseable so the
    caller can decide whether to fall through to the reference-number
    signal.
    """
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    # Strip an ISO-3-letter currency prefix if present.
    if len(text) >= 4 and text[:3].isalpha():
        text = text[3:]
    try:
        return float(text)
    except ValueError:
        return None


def _amount_matches(a: float | None, b: float | None) -> bool:
    """Both must be present and within tolerance."""
    if a is None or b is None:
        return False
    return abs(a - b) <= _AMOUNT_TOLERANCE


def _normalize_refs(value: str | None) -> set[str]:
    """Split the comma-separated reference-numbers string into a set.

    Empty string / None → empty set. Trim + casefold each entry. Empty
    fragments are dropped so a stray "RN-001," doesn't smuggle a "" into
    the set that would match every other empty-ref doc.
    """
    if not value:
        return set()
    out: set[str] = set()
    for entry in value.split(","):
        clean = entry.strip().casefold()
        if clean:
            out.add(clean)
    return out


__all__ = ["DocFields", "find_duplicates"]
