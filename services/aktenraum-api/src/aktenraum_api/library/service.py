from __future__ import annotations

from collections import Counter
from datetime import date
from typing import Any

from aktenraum_core.paperless import LIFECYCLE_TAGS

from ..ai.translate import _parse_amount
from ..paperless_gw import PaperlessGateway
from .schemas import LibraryItem, LibraryList, TagFacet, TagFacetList

# Lifecycle tags we surface as badges. Excludes ai-pending (filtered out
# entirely) and ai-low-confidence (an auxiliary that only matters for the
# review queue).
_BADGE_TAGS = frozenset(LIFECYCLE_TAGS) - {"ai-pending"}

# Tags that must NEVER appear in the user-facing tag chip / facet vocabulary —
# the lifecycle vocabulary plus the auxiliary low-confidence flag.
_INTERNAL_TAGS = frozenset(LIFECYCLE_TAGS) | {"ai-low-confidence"}

# How many non-pending documents to sample for the tag-facet aggregation. One
# upstream call instead of N. Personal-DMS scale: 500 covers years of intake;
# beyond that the facet undercounts but never lies (counts come from a real
# sample, not the inflated `tag.document_count` which includes pending docs).
_FACET_SAMPLE_SIZE = 500

# Hide tags below this prevalence so the cloud stays readable. The LLM
# occasionally invents thin tags; this filter keeps them out without us having
# to gate every extraction.
_FACET_MIN_COUNT = 2


async def list_library(
    gateway: PaperlessGateway,
    *,
    document_type: str | None,
    correspondent: str | None,
    date_from: date | None,
    date_to: date | None,
    min_amount: float | None,
    max_amount: float | None,
    text: str | None,
    tags: list[str] | None,
    page: int,
    page_size: int,
    ordering: str,
) -> LibraryList:
    correspondents = await gateway.list_correspondents()
    document_types = await gateway.list_document_types()
    tag_name_to_id = await gateway.list_tags()

    pending_id = tag_name_to_id.get("ai-pending")

    params: dict[str, Any] = {
        "ordering": ordering,
        "page": page,
    }
    if document_type:
        dt_id = document_types.get(document_type)
        if dt_id is not None:
            params["document_type__id"] = dt_id
    if correspondent:
        c_id = correspondents.get(correspondent)
        if c_id is not None:
            params["correspondent__id"] = c_id
        else:
            # Unknown name → fall back to full-text on the value so the user
            # still gets a useful answer instead of an empty list.
            text = (text + " " if text else "") + correspondent
    if date_from is not None:
        params["created__date__gte"] = date_from.isoformat()
    if date_to is not None:
        params["created__date__lte"] = date_to.isoformat()
    if text:
        params["query"] = text
    if pending_id is not None:
        params["tags__id__none"] = pending_id

    requested_tag_ids = _resolve_tag_ids(tags, tag_name_to_id)
    if tags and len(requested_tag_ids) < len([t for t in tags if t]):
        # At least one requested tag does not exist in Paperless — AND
        # semantics say zero matches without us having to round-trip.
        return LibraryList(results=[], total=0, page=page, page_size=page_size)
    if requested_tag_ids:
        # Paperless's `tags__id__all` expects a comma-separated string for AND.
        params["tags__id__all"] = ",".join(str(i) for i in requested_tag_ids)

    payload = await gateway.search_documents(params, page_size=page_size)
    raw_results = payload.get("results", [])
    total_native = payload.get("count", len(raw_results))

    correspondent_by_id = {v: k for k, v in correspondents.items()}
    document_type_by_id = {v: k for k, v in document_types.items()}
    tag_name_by_id = {v: k for k, v in tag_name_to_id.items()}
    field_id_to_name = await _custom_field_id_to_name(gateway)

    items = [
        _project(
            doc,
            correspondent_by_id=correspondent_by_id,
            document_type_by_id=document_type_by_id,
            tag_name_by_id=tag_name_by_id,
            field_id_to_name=field_id_to_name,
        )
        for doc in raw_results
    ]
    items = _apply_amount_filter(items, raw_results, field_id_to_name, min_amount, max_amount)

    if min_amount is not None or max_amount is not None:
        total = len(items)
    else:
        total = total_native

    return LibraryList(
        results=items, total=total, page=page, page_size=page_size
    )


async def list_tag_facet(gateway: PaperlessGateway) -> TagFacetList:
    """Aggregate tag occurrences across the most recent non-pending docs.

    Counts come from a real sample (not Paperless's per-tag `document_count`,
    which includes pending docs and would inflate the facet). Lifecycle and
    auxiliary tags are excluded; tags below the prevalence threshold drop out
    so the cloud stays readable.
    """
    tag_name_to_id = await gateway.list_tags()
    pending_id = tag_name_to_id.get("ai-pending")
    tag_name_by_id = {v: k for k, v in tag_name_to_id.items()}

    params: dict[str, Any] = {"ordering": "-created"}
    if pending_id is not None:
        params["tags__id__none"] = pending_id

    payload = await gateway.search_documents(params, page_size=_FACET_SAMPLE_SIZE)
    raw_results = payload.get("results", [])

    counter: Counter[str] = Counter()
    for doc in raw_results:
        for tid in doc.get("tags") or []:
            name = tag_name_by_id.get(tid)
            if not name or name in _INTERNAL_TAGS:
                continue
            counter[name] += 1

    facets = [
        TagFacet(name=name, count=count)
        for name, count in counter.most_common()
        if count >= _FACET_MIN_COUNT
    ]
    return TagFacetList(results=facets)


def _resolve_tag_ids(
    requested: list[str] | None, name_to_id: dict[str, int]
) -> list[int]:
    """Map requested tag names to ids; drop empties; preserve order."""
    if not requested:
        return []
    seen: set[int] = set()
    out: list[int] = []
    for name in requested:
        clean = name.strip()
        if not clean:
            continue
        tid = name_to_id.get(clean)
        if tid is None or tid in seen:
            continue
        out.append(tid)
        seen.add(tid)
    return out


async def _custom_field_id_to_name(gateway: PaperlessGateway) -> dict[int, str]:
    name_to_id = await gateway._get_custom_field_ids()  # noqa: SLF001
    return {fid: name for name, fid in name_to_id.items()}


def _project(
    doc: dict,
    *,
    correspondent_by_id: dict[int, str],
    document_type_by_id: dict[int, str],
    tag_name_by_id: dict[int, str],
    field_id_to_name: dict[int, str],
) -> LibraryItem:
    custom_fields = _custom_field_values(doc, field_id_to_name)
    tag_names = [tag_name_by_id.get(tid) for tid in (doc.get("tags") or [])]
    lifecycle = [n for n in tag_names if n and n in _BADGE_TAGS]
    user_tags = [n for n in tag_names if n and n not in _INTERNAL_TAGS]

    return LibraryItem(
        id=doc["id"],
        title=doc.get("title") or f"Dokument #{doc['id']}",
        created=_parse_date(doc.get("created_date") or doc.get("created")),
        correspondent=correspondent_by_id.get(doc.get("correspondent"))
        or custom_fields.get("ai_correspondent"),
        document_type=document_type_by_id.get(doc.get("document_type"))
        or custom_fields.get("ai_document_type"),
        monetary_amount=custom_fields.get("ai_monetary_amount"),
        lifecycle_tags=lifecycle,
        tags=user_tags,
    )


def _custom_field_values(
    doc: dict, field_id_to_name: dict[int, str]
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for cf in doc.get("custom_fields") or []:
        name = field_id_to_name.get(cf.get("field"))
        if name:
            out[name] = cf.get("value")
    return out


def _apply_amount_filter(
    items: list[LibraryItem],
    raw_results: list[dict],
    field_id_to_name: dict[int, str],
    min_amount: float | None,
    max_amount: float | None,
) -> list[LibraryItem]:
    if min_amount is None and max_amount is None:
        return items
    raw_by_id = {r["id"]: r for r in raw_results}
    name_by_id = {fid: name for fid, name in field_id_to_name.items()}
    monetary_field_id: int | None = next(
        (fid for fid, name in name_by_id.items() if name == "ai_monetary_amount"),
        None,
    )
    if monetary_field_id is None:
        # No way to evaluate the bound — drop everything so the bound has
        # meaning rather than silently being a no-op.
        return []

    kept: list[LibraryItem] = []
    for item in items:
        raw = raw_by_id.get(item.id) or {}
        amount_str = next(
            (
                cf.get("value")
                for cf in raw.get("custom_fields") or []
                if cf.get("field") == monetary_field_id
            ),
            None,
        )
        amount = _parse_amount(amount_str) if amount_str else None
        if amount is None:
            continue
        if min_amount is not None and amount < min_amount:
            continue
        if max_amount is not None and amount > max_amount:
            continue
        kept.append(item)
    return kept


def _parse_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None
