"""Business logic for the SPA trash endpoints.

Layered exactly like aktenraum_api.inbox.service: pure functions plus
gateway-bound async functions. Hard-delete paths additionally take an
optional QdrantVectorStore so the doc's RAG chunks die alongside the
Paperless doc — best-effort, never gates the Paperless response.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

import structlog
from aktenraum_core.rag import QdrantVectorStore

from ..paperless_gw import PaperlessGateway
from .schemas import EmptyTrashResponse, TrashItem, TrashList

log = structlog.get_logger()

# Paperless's default `PAPERLESS_EMPTY_TRASH_DELAY` is 30 days. The
# SPA renders "noch N Tage" using this; if the operator has tuned the
# delay the badge will be approximately wrong but never dangerously so.
_DEFAULT_TRASH_DELAY_DAYS = 30

# Oldest-deleted first by default so the rows about to auto-purge are
# at the top of the page.
_DEFAULT_ORDERING = "deleted_at"


async def list_trashed(
    gateway: PaperlessGateway,
    *,
    page: int,
    page_size: int,
    ordering: str | None = None,
) -> TrashList:
    payload = await gateway.list_trashed_documents(
        page=page,
        page_size=page_size,
        ordering=ordering or _DEFAULT_ORDERING,
    )
    rows = payload.get("results") or []
    if not rows:
        return TrashList(results=[], total=0, page=page, page_size=page_size)

    field_id_to_name = await _custom_field_id_to_name(gateway)
    correspondent_id_to_name = {
        v: k for k, v in (await gateway.list_correspondents()).items()
    }
    doctype_id_to_name = {
        v: k for k, v in (await gateway.list_document_types()).items()
    }
    items = [
        _project_trash_item(
            doc,
            field_id_to_name=field_id_to_name,
            correspondent_id_to_name=correspondent_id_to_name,
            doctype_id_to_name=doctype_id_to_name,
        )
        for doc in rows
    ]
    return TrashList(
        results=items,
        total=payload.get("count", len(items)),
        page=page,
        page_size=page_size,
    )


async def restore(gateway: PaperlessGateway, doc_id: int) -> None:
    """Restore a single doc from trash. Idempotent: restoring a doc
    that's no longer trashed maps to 404 inside the gateway."""
    await gateway.restore_documents([doc_id])


async def delete_forever(
    gateway: PaperlessGateway,
    vector_store: QdrantVectorStore | None,
    doc_id: int,
) -> None:
    """Hard-delete a single doc from trash + purge its Qdrant chunks.

    Paperless first (source of truth). Qdrant cleanup is best-effort:
    if it fails, log and swallow — the orphan is recoverable by the
    operator running the cleanup follow-up, never blocks the user.
    """
    await gateway.empty_trash(doc_ids=[doc_id])
    await _purge_chunks(vector_store, [doc_id])


async def empty(
    gateway: PaperlessGateway,
    vector_store: QdrantVectorStore | None,
) -> EmptyTrashResponse:
    """Hard-delete every doc currently in trash + purge their Qdrant
    chunks. The id enumeration happens BEFORE the empty call so we
    can purge each chunk-set afterwards; otherwise we'd only know the
    count, not the ids."""
    ids = await _list_all_trashed_ids(gateway)
    if not ids:
        return EmptyTrashResponse(emptied=0)
    await gateway.empty_trash(doc_ids=ids)
    await _purge_chunks(vector_store, ids)
    return EmptyTrashResponse(emptied=len(ids))


async def _list_all_trashed_ids(gateway: PaperlessGateway) -> list[int]:
    ids: list[int] = []
    page = 1
    page_size = 100
    while True:
        payload = await gateway.list_trashed_documents(
            page=page, page_size=page_size
        )
        for row in payload.get("results") or []:
            ids.append(int(row["id"]))
        if not payload.get("next"):
            return ids
        page += 1


async def _purge_chunks(
    vector_store: QdrantVectorStore | None, doc_ids: list[int]
) -> None:
    if vector_store is None or not doc_ids:
        return
    for doc_id in doc_ids:
        try:
            await vector_store.delete_by_doc_id(doc_id)
        except Exception as exc:  # noqa: BLE001
            # Best-effort: Paperless already hard-deleted the doc; an
            # orphaned chunk-set is a transient annoyance, not a
            # correctness bug. Operator can re-run delete-forever to
            # self-heal once Qdrant is reachable.
            log.warning(
                "trash_qdrant_purge_failed",
                doc_id=doc_id,
                error=str(exc),
            )


async def _custom_field_id_to_name(gateway: PaperlessGateway) -> dict[int, str]:
    name_to_id = await gateway._get_custom_field_ids()  # noqa: SLF001
    return {fid: name for name, fid in name_to_id.items()}


def _project_trash_item(
    doc: dict[str, Any],
    *,
    field_id_to_name: dict[int, str],
    correspondent_id_to_name: dict[int, str],
    doctype_id_to_name: dict[int, str],
) -> TrashItem:
    fields = _custom_field_values(doc, field_id_to_name)
    native_corresp = correspondent_id_to_name.get(doc.get("correspondent") or -1)
    native_doctype = doctype_id_to_name.get(doc.get("document_type") or -1)
    return TrashItem(
        id=doc["id"],
        title=doc.get("title") or f"Dokument #{doc['id']}",
        original_file_name=doc.get("original_file_name"),
        created=_parse_date(doc.get("created_date") or doc.get("created")),
        deleted_at=_parse_datetime(doc.get("deleted_at")),
        correspondent=native_corresp,
        document_type=native_doctype,
        ai_correspondent=fields.get("ai_correspondent"),
        ai_document_type=fields.get("ai_document_type"),
        ai_summary_de=fields.get("ai_summary_de"),
    )


def _custom_field_values(
    doc: dict[str, Any], field_id_to_name: dict[int, str]
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
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _parse_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            # Paperless emits ISO-8601 with trailing Z; fromisoformat
            # handles that on Python 3.11+.
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


__all__ = [
    "delete_forever",
    "empty",
    "list_trashed",
    "restore",
]
