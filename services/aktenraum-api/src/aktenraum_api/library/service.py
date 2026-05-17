from __future__ import annotations

from collections import Counter
from datetime import date
from typing import Any

from aktenraum_core.paperless import LIFECYCLE_TAGS

from .._auto_tagger import fetch_processing_state
from ..config import Settings
from ..paperless_gw import PaperlessAuthError, PaperlessGateway, PaperlessNotFoundError
from .schemas import LibraryItem, LibraryList, TagFacet, TagFacetList

# Lifecycle tags we surface as badges. Excludes ai-pending (filtered out
# entirely) and ai-low-confidence (an auxiliary that only matters for the
# review queue). `ai-auto-approved` and `ai-duplicate` are auxiliary
# markers that persist through propagation, so they join the badge
# vocabulary so the SPA can render an "Auto-genehmigt" / "Duplikat"
# pill. Intentional asymmetry below: ai-auto-approved is ALSO listed in
# _INTERNAL_TAGS (the user never filters by it), but ai-duplicate is NOT
# — the user explicitly wants to filter Library by `?tags=ai-duplicate`
# to find candidates to resolve.
_BADGE_TAGS = (
    (frozenset(LIFECYCLE_TAGS) - {"ai-pending"})
    | {"ai-auto-approved", "ai-duplicate"}
)

# Tags that must NEVER appear in the user-facing tag chip / facet vocabulary —
# the lifecycle vocabulary plus the auxiliary low-confidence and
# auto-approved flags.
_INTERNAL_TAGS = frozenset(LIFECYCLE_TAGS) | {
    "ai-low-confidence",
    "ai-auto-approved",
}

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
    text: str | None,
    tags: list[str] | None,
    page: int,
    page_size: int,
    ordering: str,
    settings: Settings | None = None,
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

    # Page-1 prepend: pin docs the auto-tagger is *actively* working on
    # (extraction / propagation / indexer slots) to the top so the user
    # doesn't have to paginate to find a freshly-uploaded doc. Best-
    # effort: when the auto-tagger is unreachable we silently fall back
    # to the natural-sort page.
    if page == 1 and settings is not None and settings.auto_tagger_url:
        in_flight_ids = await _fetch_in_flight_ids(settings)
        if in_flight_ids:
            pinned_rows: list[LibraryItem] = []
            for doc_id in in_flight_ids:
                row = await _project_in_flight_row(
                    gateway,
                    doc_id,
                    correspondent_by_id=correspondent_by_id,
                    document_type_by_id=document_type_by_id,
                    tag_name_by_id=tag_name_by_id,
                    field_id_to_name=field_id_to_name,
                )
                if row is not None:
                    pinned_rows.append(row)
            if pinned_rows:
                pinned_id_set = {r.id for r in pinned_rows}
                items = pinned_rows + [
                    item for item in items if item.id not in pinned_id_set
                ]

    return LibraryList(
        results=items, total=total_native, page=page, page_size=page_size
    )


async def _fetch_in_flight_ids(settings: Settings) -> list[int]:
    """Return the doc ids the auto-tagger is actively processing right now.

    Dedup-preserves order so the pin layout is stable across requests
    (extraction first, then propagation, then indexer per ProcessingState
    snapshot shape). Empty list when the auto-tagger is unreachable, idle,
    or mis-configured.
    """
    body = await fetch_processing_state(settings)
    if not body:
        return []
    raw = body.get("processing") or []
    seen: set[int] = set()
    ordered: list[int] = []
    for raw_id in raw:
        try:
            doc_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if doc_id in seen:
            continue
        seen.add(doc_id)
        ordered.append(doc_id)
    return ordered


async def _project_in_flight_row(
    gateway: PaperlessGateway,
    doc_id: int,
    *,
    correspondent_by_id: dict[int, str],
    document_type_by_id: dict[int, str],
    tag_name_by_id: dict[int, str],
    field_id_to_name: dict[int, str],
) -> LibraryItem | None:
    """Fetch a single doc by id and project to a pinned LibraryItem.

    Returns None when the doc cannot be projected (404 because it was
    deleted between /processing reporting it and us reading it; auth
    error; any other gateway exception). Pinning is best-effort and a
    missing row simply means the user sees the natural-sort page-1 with
    one fewer pin.
    """
    try:
        doc = await gateway.get_document(doc_id)
    except (PaperlessNotFoundError, PaperlessAuthError):
        return None
    except Exception:
        return None
    item = _project(
        doc,
        correspondent_by_id=correspondent_by_id,
        document_type_by_id=document_type_by_id,
        tag_name_by_id=tag_name_by_id,
        field_id_to_name=field_id_to_name,
    )
    return item.model_copy(update={"is_processing": True})


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
        original_file_name=doc.get("original_file_name"),
        created=_parse_date(doc.get("created_date") or doc.get("created")),
        correspondent=correspondent_by_id.get(doc.get("correspondent"))
        or custom_fields.get("ai_correspondent"),
        document_type=document_type_by_id.get(doc.get("document_type"))
        or custom_fields.get("ai_document_type"),
        lifecycle_tags=lifecycle,
        tags=user_tags,
        ai_error_message=custom_fields.get("ai_error_message"),
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
