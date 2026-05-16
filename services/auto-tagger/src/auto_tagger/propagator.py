import asyncio

import structlog
from aktenraum_core.paperless import LIFECYCLE_TAGS, PaperlessClient

log = structlog.get_logger()

_LIFECYCLE_SET = set(LIFECYCLE_TAGS)


def _format_error(label: str, exc: BaseException) -> str:
    """Compact, user-facing error string for the ai_error_message field.

    Mirrors `tagger._format_error` (kept independent so the two modules don't
    cross-import). German prefix; 2 KB cap.
    """
    cls = type(exc).__name__
    msg = str(exc).strip() or repr(exc)
    out = f"{label} – {cls}: {msg}"
    if len(out) > 2000:
        out = out[:1997] + "…"
    return out


def _split_suggested_tags(raw: str | None) -> list[str]:
    """Parse the comma-separated string Paperless stores in ai_suggested_tags.

    Filters out lifecycle tag names so the LLM's suggestions can never collide
    with the pipeline state machine, and drops any tag truncated by the
    128-char string-field limit (those end with '…' from `_truncate_string_field`).
    """
    if not raw:
        return []
    out: list[str] = []
    for piece in raw.split(","):
        name = piece.strip()
        if not name or name in _LIFECYCLE_SET or name.endswith("…"):
            continue
        out.append(name)
    return out


async def process_approved_document(
    doc: dict,
    paperless: PaperlessClient,
    *,
    indexing_queue: asyncio.Queue[int] | None = None,
) -> None:
    """Copy AI custom fields onto native Paperless fields and swap tag state.

    Reads the document's ai_correspondent / ai_document_type / ai_issue_date /
    ai_suggested_tags custom fields, resolves each into the corresponding
    native Paperless entity (creating one if needed), and issues a single
    PATCH that:

      - sets correspondent / document_type / created_date
      - removes ai-approved from the tag set
      - adds ai-propagated
      - merges in the suggested tags

    On failure, swaps ai-approved for ai-propagation-error so the doc does not
    loop on every poll cycle.

    On success, enqueues the doc id on `indexing_queue` (when supplied) so
    the RAG indexer worker (`indexer.index_document`) can chunk + embed +
    upsert it. The queue is optional so a deployment that runs without
    Qdrant (QDRANT_URL empty) keeps the existing extraction +
    propagation path working untouched.
    """
    doc_id: int = doc["id"]
    title: str = doc.get("title", f"doc-{doc_id}")
    logger = log.bind(doc_id=doc_id, title=title)
    logger.info("propagation_started")

    current_tags: list[int] = list(doc.get("tags", []))
    approved_id = await paperless._get_tag_id("ai-approved")

    try:
        ai_fields = await paperless.get_ai_custom_field_values(doc_id)

        correspondent_id: int | None = None
        if name := (ai_fields.get("ai_correspondent") or "").strip():
            correspondent_id = await paperless.get_or_create_correspondent(name)

        document_type_id: int | None = None
        if name := (ai_fields.get("ai_document_type") or "").strip():
            document_type_id = await paperless.get_or_create_document_type(name)

        created_date: str | None = ai_fields.get("ai_issue_date") or None

        # ai_title becomes the Paperless native `title` so the doc surfaces as
        # the AI-suggested name in every list view. The original filename
        # (`original_file_name`) stays on the Paperless side and is rendered
        # alongside the AI title in the SPA — title is the speaking label,
        # original_file_name is the provenance.
        ai_title: str | None = (ai_fields.get("ai_title") or "").strip() or None

        suggested_tag_ids: list[int] = []
        for name in _split_suggested_tags(ai_fields.get("ai_suggested_tags")):
            suggested_tag_ids.append(await paperless.get_or_create_tag(name))

        propagated_id = await paperless.get_or_create_tag("ai-propagated")

        new_tag_set = set(current_tags)
        if approved_id is not None:
            new_tag_set.discard(approved_id)
        new_tag_set.add(propagated_id)
        new_tag_set.update(suggested_tag_ids)

        # Shield the lifecycle-flipping PATCH from task cancellation
        # (SIGTERM during a graceful shutdown). A partial cancellation
        # between sending and acknowledging would leave the doc with
        # `ai-approved` cleared but `ai-propagated` not added — the doc
        # would re-enter the AI pipeline on next boot and could double-
        # apply suggested tags. shield() guarantees the PATCH either
        # completes or never starts.
        await asyncio.shield(
            paperless.patch_document_native_fields(
                doc_id,
                correspondent=correspondent_id,
                document_type=document_type_id,
                created_date=created_date,
                tags=sorted(new_tag_set),
                title=ai_title,
            )
        )

        # Successful propagation clears any prior failure message. Propagation
        # only touches native fields, so we explicitly clear the custom field
        # (the extraction success path drops it via full-array replace; here
        # we need a targeted write).
        await paperless.set_error_message(doc_id, None)

        logger.info(
            "propagation_successful",
            correspondent_id=correspondent_id,
            document_type_id=document_type_id,
            created_date=created_date,
            tags_added=len(suggested_tag_ids),
        )
        if indexing_queue is not None:
            # `put_nowait` here rather than `await put` so propagation never
            # blocks waiting for the indexer; the queue is bounded upstream
            # and a full queue logs and drops (we'd rather miss an index
            # event than stall propagation).
            try:
                indexing_queue.put_nowait(doc_id)
            except asyncio.QueueFull:
                logger.warning("indexing_queue_full", doc_id=doc_id)
    except Exception as exc:
        logger.exception("propagation_failed", error=str(exc))
        try:
            await paperless.set_error_message(
                doc_id, _format_error("Übertragung fehlgeschlagen", exc)
            )
            error_id = await paperless.get_or_create_tag("ai-propagation-error")
            recovery_set = set(current_tags)
            if approved_id is not None:
                recovery_set.discard(approved_id)
            recovery_set.add(error_id)
            await paperless.patch_document_native_fields(doc_id, tags=sorted(recovery_set))
        except Exception as inner:
            logger.error("propagation_error_tag_failed", error=str(inner))
