"""Translate SearchFilter → Paperless query params, plus post-fetch amount filter.

Native fields go into the `/api/documents/?…` query string. Custom fields
(amount) are not filterable via the Paperless API at this version, so we
fetch a generous page and drop results in-memory.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from .schemas import DocumentSummary, SearchFilter

_MONETARY_RE = re.compile(r"([+-]?\d+(?:[.,]\d+)?)")


def filter_to_paperless_params(
    f: SearchFilter,
    *,
    correspondent_id: int | None,
    document_type_id: int | None,
) -> dict[str, Any]:
    """Map the populated fields of `f` to a dict of Paperless query params.

    `correspondent_id` and `document_type_id` are the resolved native ids the
    caller looked up beforehand. If a name was supplied but not found, the
    caller passes None and is responsible for falling back to `text`.
    """
    # Paperless's `/api/documents/?correspondent=` and `?document_type=` are
    # silently ignored (returning the unfiltered list) — same gotcha as `?name=`
    # on `/api/tags/`. The working filters are `correspondent__id` and
    # `document_type__id`.
    params: dict[str, Any] = {}
    if document_type_id is not None:
        params["document_type__id"] = document_type_id
    if correspondent_id is not None:
        params["correspondent__id"] = correspondent_id
    if f.date_from is not None:
        params["created__date__gte"] = _iso(f.date_from)
    if f.date_to is not None:
        params["created__date__lte"] = _iso(f.date_to)
    if f.text:
        params["query"] = f.text
    return params


def apply_post_filter(
    results: list[dict],
    f: SearchFilter,
    *,
    name_by_id: dict[str, dict[int, str]],
    monetary_field_id: int | None,
    tag_name_by_id: dict[int, str] | None = None,
    lifecycle_tag_names: frozenset[str] | None = None,
) -> list[DocumentSummary]:
    """Drop results outside [min_amount, max_amount], project to DocumentSummary.

    `name_by_id` maps entity-kind → {id: name} for "correspondents" and
    "document_types", used to resolve foreign keys on each result so the SPA
    receives display strings. `monetary_field_id` is the Paperless custom-field
    id for `ai_monetary_amount`; passing None disables amount filtering for
    callers without that field configured. `tag_name_by_id` plus the
    `lifecycle_tag_names` allowlist let the projection populate
    `DocumentSummary.lifecycle_tags` so the SPA can render "Wartet auf KI" /
    "Wird übertragen" / … badges. If either is omitted, lifecycle_tags stays
    empty (older callers continue to work).
    """
    correspondents = name_by_id.get("correspondents", {})
    document_types = name_by_id.get("document_types", {})

    has_amount_bound = f.min_amount is not None or f.max_amount is not None

    out: list[DocumentSummary] = []
    for doc in results:
        amount_str = _read_monetary(doc, monetary_field_id)
        amount_value = _parse_amount(amount_str)

        if has_amount_bound:
            if amount_value is None:
                continue
            if f.min_amount is not None and amount_value < f.min_amount:
                continue
            if f.max_amount is not None and amount_value > f.max_amount:
                continue

        lifecycle: list[str] = []
        if tag_name_by_id and lifecycle_tag_names:
            for tid in doc.get("tags") or []:
                name = tag_name_by_id.get(tid)
                if name and name in lifecycle_tag_names:
                    lifecycle.append(name)

        out.append(
            DocumentSummary(
                id=doc["id"],
                title=doc.get("title") or f"Dokument #{doc['id']}",
                correspondent=correspondents.get(doc.get("correspondent")),
                document_type=document_types.get(doc.get("document_type")),
                created=_parse_date_field(doc.get("created_date") or doc.get("created")),
                monetary_amount=amount_str,
                lifecycle_tags=lifecycle,
            )
        )
    return out


def _iso(d: date) -> str:
    return d.isoformat()


def _read_monetary(doc: dict, field_id: int | None) -> str | None:
    if field_id is None:
        return None
    for cf in doc.get("custom_fields") or []:
        if cf.get("field") == field_id:
            value = cf.get("value")
            return str(value) if value is not None else None
    return None


def _parse_amount(value: str | None) -> float | None:
    """Parse Paperless `<ISO><amount>` (e.g. "EUR149.99") and German variants.

    Returns None if no number can be extracted.
    """
    if not value:
        return None
    # Anglo format: "EUR149.99". Strip currency prefix.
    cleaned = re.sub(r"^[A-Za-z]{3}\s*", "", value).strip()
    # German format: "149,99 EUR" → strip trailing currency, swap comma → dot.
    cleaned = re.sub(r"\s*[A-Za-z€$£¥]+\s*$", "", cleaned).strip()
    if "," in cleaned and "." in cleaned:
        # "1.234,56" → "1234.56"
        cleaned = cleaned.replace(".", "").replace(",", ".")
    elif "," in cleaned:
        cleaned = cleaned.replace(",", ".")
    m = _MONETARY_RE.search(cleaned)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _parse_date_field(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        # Paperless returns either YYYY-MM-DD or full ISO timestamp; both start
        # with the date.
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None
