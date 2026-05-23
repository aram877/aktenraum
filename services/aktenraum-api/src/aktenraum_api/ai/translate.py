"""Translate SearchFilter → Paperless query params and project results.

The generic monetary_amount field was removed; per-type money fields live
on the type-specific schemas instead. This module no longer handles
amount filtering at all.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from .schemas import DocumentSummary, SearchFilter


def filter_to_paperless_params(
    f: SearchFilter,
    *,
    correspondent_id: int | None,
    document_type_id: int | None,
    tag_ids: list[int] | None = None,
) -> dict[str, Any]:
    """Map the populated fields of `f` to a dict of Paperless query params.

    `correspondent_id` and `document_type_id` are the resolved native ids the
    caller looked up beforehand. If a name was supplied but not found, the
    caller passes None and is responsible for falling back to `text`.
    `tag_ids` is the resolved id list for `f.tags`; AND semantics translate
    to Paperless's `tags__id__all` (comma-separated).
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
    if tag_ids:
        params["tags__id__all"] = ",".join(str(i) for i in tag_ids)
    return params


def apply_post_filter(
    results: list[dict],
    f: SearchFilter,
    *,
    name_by_id: dict[str, dict[int, str]],
    tag_name_by_id: dict[int, str] | None = None,
    lifecycle_tag_names: frozenset[str] | None = None,
    error_field_id: int | None = None,
) -> list[DocumentSummary]:
    """Project Paperless docs into DocumentSummary, surfacing lifecycle tags.

    `name_by_id` maps entity-kind → {id: name} for "correspondents" and
    "document_types", used to resolve foreign keys on each result so the SPA
    receives display strings. `tag_name_by_id` plus the `lifecycle_tag_names`
    allowlist let the projection populate `DocumentSummary.lifecycle_tags`
    so the SPA can render "Wartet auf KI" / "Wird übertragen" / … badges.
    `error_field_id` is the resolved id of the `ai_error_message` custom
    field — when supplied, the projection surfaces the field's value so the
    SPA can tooltip the real failure reason on the lifecycle badge. Any
    omitted parameter stays opt-out (older callers continue to work).
    """
    # f is unused now (post-filter no longer narrows results) but kept in
    # the signature to avoid churn at every caller.
    del f
    correspondents = name_by_id.get("correspondents", {})
    document_types = name_by_id.get("document_types", {})

    out: list[DocumentSummary] = []
    for doc in results:
        lifecycle: list[str] = []
        user_tags: list[str] = []
        if tag_name_by_id:
            for tid in doc.get("tags") or []:
                name = tag_name_by_id.get(tid)
                if not name:
                    continue
                if lifecycle_tag_names and name in lifecycle_tag_names:
                    lifecycle.append(name)
                else:
                    user_tags.append(name)

        error_message: str | None = None
        if error_field_id is not None:
            for cf in doc.get("custom_fields") or []:
                if cf.get("field") == error_field_id:
                    raw = cf.get("value")
                    error_message = raw if isinstance(raw, str) and raw else None
                    break

        out.append(
            DocumentSummary(
                id=doc["id"],
                title=doc.get("title") or f"Dokument #{doc['id']}",
                original_file_name=doc.get("original_file_name"),
                correspondent=correspondents.get(doc.get("correspondent")),
                document_type=document_types.get(doc.get("document_type")),
                created=_parse_date_field(doc.get("created_date") or doc.get("created")),
                lifecycle_tags=lifecycle,
                tags=user_tags,
                ai_error_message=error_message,
            )
        )
    return out


def _iso(d: date) -> str:
    return d.isoformat()


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
