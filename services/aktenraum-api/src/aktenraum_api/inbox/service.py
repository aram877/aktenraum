from __future__ import annotations

from datetime import date
from typing import Any

from aktenraum_core.paperless import LIFECYCLE_TAGS
from sqlalchemy.ext.asyncio import AsyncSession

from ..paperless_gw import PaperlessGateway
from ..type_fields import service as type_fields_service
from .schemas import InboxDetail, InboxFieldUpdate, InboxItem, InboxList

PENDING_TAG = "ai-pending"
APPROVED_TAG = "ai-approved"
REJECTED_TAG = "ai-rejected"
LOW_CONFIDENCE_TAG = "ai-low-confidence"

_CONTENT_EXCERPT_LIMIT = 2000


async def list_pending(
    gateway: PaperlessGateway, *, page: int, page_size: int, ordering: str = "-modified"
) -> InboxList:
    name_to_id = await gateway.list_tags()
    pending_id = name_to_id.get(PENDING_TAG)
    low_conf_id = name_to_id.get(LOW_CONFIDENCE_TAG)
    if pending_id is None:
        return InboxList(results=[], total=0, page=page, page_size=page_size)

    payload = await gateway.search_documents(
        {
            "tags__id": pending_id,
            "ordering": ordering,
            "page": page,
        },
        page_size=page_size,
    )
    field_id_to_name = await _custom_field_id_to_name(gateway)
    results = [
        _project_inbox_item(doc, field_id_to_name=field_id_to_name, low_conf_id=low_conf_id)
        for doc in payload.get("results", [])
    ]
    return InboxList(
        results=results,
        total=payload.get("count", len(results)),
        page=page,
        page_size=page_size,
    )


async def get_detail(
    gateway: PaperlessGateway,
    doc_id: int,
    session: AsyncSession | None = None,
) -> InboxDetail:
    doc = await gateway.get_document(doc_id)
    field_id_to_name = await _custom_field_id_to_name(gateway)
    tag_id_to_name = {v: k for k, v in (await gateway.list_tags()).items()}
    detail = _project_inbox_detail(
        doc,
        field_id_to_name=field_id_to_name,
        tag_id_to_name=tag_id_to_name,
    )
    if session is not None:
        row = await type_fields_service.get(session, doc_id)
        detail.type_fields = dict(row.fields) if row and row.fields else None
    return detail


async def apply_field_update(
    gateway: PaperlessGateway,
    doc_id: int,
    update: InboxFieldUpdate,
) -> InboxDetail:
    populated = update.populated()
    if populated:
        # Fetch once and reuse for the merge-read inside
        # patch_document_custom_fields. Saves one GET on every field edit.
        doc = await gateway.get_document(doc_id)
        await gateway.patch_document_custom_fields(
            doc_id, populated, prefetched_doc=doc
        )
    return await get_detail(gateway, doc_id)


async def approve(
    gateway: PaperlessGateway,
    doc_id: int,
    update: InboxFieldUpdate | None = None,
) -> InboxDetail:
    if update is not None and update.populated():
        doc = await gateway.get_document(doc_id)
        await gateway.patch_document_custom_fields(
            doc_id, update.populated(), prefetched_doc=doc
        )
    await gateway.swap_lifecycle_tag(
        doc_id,
        remove=[PENDING_TAG, LOW_CONFIDENCE_TAG],
        add=[APPROVED_TAG],
    )
    return await get_detail(gateway, doc_id)


async def reject(gateway: PaperlessGateway, doc_id: int) -> InboxDetail:
    await gateway.swap_lifecycle_tag(
        doc_id,
        remove=[PENDING_TAG, LOW_CONFIDENCE_TAG],
        add=[REJECTED_TAG],
    )
    return await get_detail(gateway, doc_id)


async def _custom_field_id_to_name(gateway: PaperlessGateway) -> dict[int, str]:
    name_to_id = await gateway._get_custom_field_ids()  # noqa: SLF001
    return {fid: name for name, fid in name_to_id.items()}


def _project_inbox_item(
    doc: dict,
    *,
    field_id_to_name: dict[int, str],
    low_conf_id: int | None,
) -> InboxItem:
    fields = _custom_field_values(doc, field_id_to_name)
    return InboxItem(
        id=doc["id"],
        title=doc.get("title") or f"Dokument #{doc['id']}",
        original_file_name=doc.get("original_file_name"),
        created=_parse_date(doc.get("created_date") or doc.get("created")),
        ai_correspondent=fields.get("ai_correspondent"),
        ai_document_type=fields.get("ai_document_type"),
        ai_title=fields.get("ai_title"),
        ai_issue_date=fields.get("ai_issue_date"),
        ai_confidence=fields.get("ai_confidence"),
        low_confidence=low_conf_id is not None and low_conf_id in (doc.get("tags") or []),
        ai_error_message=fields.get("ai_error_message"),
    )


def _project_inbox_detail(
    doc: dict,
    *,
    field_id_to_name: dict[int, str],
    tag_id_to_name: dict[int, str],
) -> InboxDetail:
    fields = _custom_field_values(doc, field_id_to_name)
    tag_names = [tag_id_to_name.get(tid) for tid in (doc.get("tags") or [])]
    tag_names_clean = [name for name in tag_names if name]
    content = (doc.get("content") or "")[:_CONTENT_EXCERPT_LIMIT]
    return InboxDetail(
        id=doc["id"],
        title=doc.get("title") or f"Dokument #{doc['id']}",
        original_file_name=doc.get("original_file_name"),
        created=_parse_date(doc.get("created_date") or doc.get("created")),
        ai_correspondent=fields.get("ai_correspondent"),
        ai_document_type=fields.get("ai_document_type"),
        ai_title=fields.get("ai_title"),
        ai_issue_date=fields.get("ai_issue_date"),
        ai_reference_numbers=fields.get("ai_reference_numbers"),
        ai_suggested_tags=fields.get("ai_suggested_tags"),
        ai_summary_de=fields.get("ai_summary_de"),
        ai_confidence=fields.get("ai_confidence"),
        ai_backend=fields.get("ai_backend"),
        ai_model=fields.get("ai_model"),
        ai_confidence_reason=fields.get("ai_confidence_reason"),
        ai_error_message=fields.get("ai_error_message"),
        low_confidence=LOW_CONFIDENCE_TAG in tag_names_clean,
        tags=tag_names_clean,
        content_excerpt=content,
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


__all__ = [
    "APPROVED_TAG",
    "LIFECYCLE_TAGS",
    "LOW_CONFIDENCE_TAG",
    "PENDING_TAG",
    "REJECTED_TAG",
    "apply_field_update",
    "approve",
    "get_detail",
    "list_pending",
    "reject",
]
