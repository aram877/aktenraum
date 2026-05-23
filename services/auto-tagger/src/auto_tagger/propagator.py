import asyncio

import structlog
from aktenraum_core.paperless import LIFECYCLE_TAGS, PaperlessClient

from .dedup import DocFields, find_duplicates

log = structlog.get_logger()

_LIFECYCLE_SET = set(LIFECYCLE_TAGS)

# Cap on candidates scanned per duplicate-detection round. Heavy
# correspondents (banks, monthly billing services) can accumulate
# hundreds of propagated docs; capping at 200 keeps the Paperless GET
# bounded and the in-process comparison loop fast. Default sort is
# `-modified` so the most-recent docs are inside the cap — the case
# we most care about for newly-arrived duplicates.
_DUPLICATE_CANDIDATE_CAP = 200


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


async def _find_duplicate_ids(
    paperless: PaperlessClient,
    new_doc: dict,
    correspondent_id: int,
    ai_fields: dict,
) -> list[int]:
    """Fetch propagated docs for the same correspondent and feed them
    plus the new doc's fields to the detector.

    Pure orchestration: the matching rule lives in `dedup.find_duplicates`.
    Returns an empty list when:
      - the new doc itself carries `ai-duplicate-dismissed` (operator has
        explicitly said it's not a duplicate — never re-flag it),
      - the correspondent has no other propagated docs yet,
      - detection short-circuits on a missing anchor.

    Candidates carrying `ai-duplicate-dismissed` are also filtered out so
    the operator's prior decision sticks even when a new doc lands in
    the same correspondent.
    """
    dismissed_id = await _try_get_tag_id(paperless, "ai-duplicate-dismissed")
    new_doc_id = int(new_doc["id"])
    new_doc_tags = set(new_doc.get("tags") or [])
    if dismissed_id is not None and dismissed_id in new_doc_tags:
        return []

    candidates = await paperless.get_documents_with_tag(
        "ai-propagated",
        batch_size=_DUPLICATE_CANDIDATE_CAP,
        ordering="-modified",
        extra_params={"correspondent__id": correspondent_id},
    )
    if not candidates:
        return []
    if dismissed_id is not None:
        candidates = [
            c
            for c in candidates
            if dismissed_id not in (c.get("tags") or [])
        ]
        if not candidates:
            return []
    field_name_by_id = await paperless.get_custom_field_name_by_id()
    new_doc_fields = DocFields(
        id=new_doc_id,
        correspondent=ai_fields.get("ai_correspondent"),
        issue_date=ai_fields.get("ai_issue_date"),
        monetary_amount=ai_fields.get("ai_monetary_amount"),
        reference_numbers=ai_fields.get("ai_reference_numbers"),
    )
    candidate_fields = [
        _doc_to_fields(c, field_name_by_id) for c in candidates
    ]
    return find_duplicates(new_doc_fields, candidate_fields)


async def _try_get_tag_id(paperless: PaperlessClient, name: str) -> int | None:
    """Look up a tag id without creating it. Returns None when missing.

    The dedup detector needs to KNOW whether `ai-duplicate-dismissed`
    exists, not create it as a side effect of running propagation. The
    SPA's dismiss endpoint is the only path that should create the tag.

    Best-effort: any failure (HTTP error, unexpected mock shape, missing
    method) returns None so the calling dedup path proceeds as if the
    dismissed tag isn't in use. Safer than failing the whole propagation
    when the dedup dismissal feature happens to be unavailable.
    """
    try:
        # PaperlessClient caches its tag map; this is a cheap dict lookup
        # after the first call per process.
        tag_ids = await paperless.get_entity_name_map("/api/tags/")
        # Guard against mock/wrong-type returns: only iterate real dicts
        # so tests that don't set up this helper don't blow up with
        # AsyncMock coroutine warnings.
        if not isinstance(tag_ids, dict):
            return None
        for tid, tname in tag_ids.items():
            if tname == name:
                return tid
    except Exception:  # noqa: BLE001
        return None
    return None


def _doc_to_fields(doc: dict, field_name_by_id: dict[int, str]) -> DocFields:
    """Project a Paperless document blob into the detector's DocFields."""
    values: dict[str, str] = {}
    for entry in doc.get("custom_fields") or []:
        name = field_name_by_id.get(entry.get("field"))
        if not name:
            continue
        value = entry.get("value")
        if isinstance(value, str):
            values[name] = value
        elif value is not None:
            values[name] = str(value)
    return DocFields(
        id=int(doc["id"]),
        correspondent=values.get("ai_correspondent"),
        issue_date=values.get("ai_issue_date"),
        monetary_amount=values.get("ai_monetary_amount"),
        reference_numbers=values.get("ai_reference_numbers"),
    )


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

        # Duplicate detection runs against the existing propagated
        # corpus for the same correspondent. Done BEFORE the lifecycle
        # PATCH so any matched id can be added to the same write set
        # (one PATCH instead of two for the new doc). Best-effort: a
        # detection failure must not break propagation.
        duplicate_ids: list[int] = []
        if correspondent_id is not None:
            try:
                duplicate_ids = await _find_duplicate_ids(
                    paperless,
                    doc,
                    correspondent_id,
                    ai_fields,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("duplicate_detection_failed", error=str(exc))

        new_tag_set = set(current_tags)
        if approved_id is not None:
            new_tag_set.discard(approved_id)
        new_tag_set.add(propagated_id)
        new_tag_set.update(suggested_tag_ids)
        if duplicate_ids:
            duplicate_tag_id = await paperless.get_or_create_tag("ai-duplicate")
            new_tag_set.add(duplicate_tag_id)

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

        # Tag each matched counterpart with `ai-duplicate`. Per-id
        # failures are swallowed: propagation itself already succeeded
        # for the new doc, and the matched docs were already propagated
        # (so they're not at risk). A future propagation of any other
        # doc in this cluster will re-tag if needed.
        for matched_id in duplicate_ids:
            try:
                await paperless.add_tag_to_document(matched_id, "ai-duplicate")
                logger.info(
                    "duplicate_detected",
                    new_doc_id=doc_id,
                    matched_id=matched_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "duplicate_tag_failed",
                    matched_id=matched_id,
                    error=str(exc),
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
