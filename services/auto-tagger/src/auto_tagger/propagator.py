import structlog
from aktenraum_core.paperless import LIFECYCLE_TAGS, PaperlessClient

log = structlog.get_logger()

_LIFECYCLE_SET = set(LIFECYCLE_TAGS)


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


async def process_approved_document(doc: dict, paperless: PaperlessClient) -> None:
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

        suggested_tag_ids: list[int] = []
        for name in _split_suggested_tags(ai_fields.get("ai_suggested_tags")):
            suggested_tag_ids.append(await paperless.get_or_create_tag(name))

        propagated_id = await paperless.get_or_create_tag("ai-propagated")

        new_tag_set = set(current_tags)
        if approved_id is not None:
            new_tag_set.discard(approved_id)
        new_tag_set.add(propagated_id)
        new_tag_set.update(suggested_tag_ids)

        await paperless.patch_document_native_fields(
            doc_id,
            correspondent=correspondent_id,
            document_type=document_type_id,
            created_date=created_date,
            tags=sorted(new_tag_set),
        )

        logger.info(
            "propagation_successful",
            correspondent_id=correspondent_id,
            document_type_id=document_type_id,
            created_date=created_date,
            tags_added=len(suggested_tag_ids),
        )
    except Exception as exc:
        logger.exception("propagation_failed", error=str(exc))
        try:
            error_id = await paperless.get_or_create_tag("ai-propagation-error")
            recovery_set = set(current_tags)
            if approved_id is not None:
                recovery_set.discard(approved_id)
            recovery_set.add(error_id)
            await paperless.patch_document_native_fields(doc_id, tags=sorted(recovery_set))
        except Exception as inner:
            logger.error("propagation_error_tag_failed", error=str(inner))
