from typing import Any

import httpx
import structlog

from ..models import DocumentExtraction
from .normalisers import (
    _normalize_date,
    truncate_for_field,
)

log = structlog.get_logger()


# Tags that mark a document as having entered the AI pipeline. The auto-tagger
# excludes documents carrying any of these from its unprocessed-doc query, and
# the propagator filters by individual states (ai-approved, ai-propagated, …).
#
# `ai-auto-approved` is an auxiliary marker — NOT a lifecycle state. It lives
# alongside `ai-approved` (and later `ai-propagated`) so the UI can show
# "auto-genehmigt" forever. It's intentionally excluded from this tuple so the
# poller's "no lifecycle tag" filter doesn't change behaviour.
LIFECYCLE_TAGS = (
    "ai-pending",
    "ai-approved",
    "ai-rejected",
    "ai-propagated",
    "ai-propagation-error",
    "ai-error",
)


class PaperlessClient:
    def __init__(self, base_url: str, api_token: str) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Token {api_token}"},
            timeout=30.0,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()

    # ------------------------------------------------------------------
    # Documents
    # ------------------------------------------------------------------

    async def get_unprocessed_documents(self, batch_size: int = 5) -> list[dict]:
        """Return documents with none of the AI lifecycle tags."""
        tag_ids = [await self._get_tag_id(name) for name in LIFECYCLE_TAGS]
        exclude_ids = ",".join(str(i) for i in tag_ids if i is not None)
        params: dict[str, Any] = {"ordering": "created", "page_size": batch_size}
        if exclude_ids:
            params["tags__id__none"] = exclude_ids

        resp = await self._client.get("/api/documents/", params=params)
        resp.raise_for_status()
        return resp.json().get("results", [])

    async def get_document(self, doc_id: int) -> dict:
        """Fetch a single document by id. Returns the full doc dict including
        content and custom_fields."""
        resp = await self._client.get(f"/api/documents/{doc_id}/")
        resp.raise_for_status()
        return resp.json()

    async def get_document_content(self, doc_id: int) -> str:
        resp = await self._client.get(f"/api/documents/{doc_id}/")
        resp.raise_for_status()
        return resp.json().get("content", "")

    async def patch_document_ai_fields(
        self,
        doc_id: int,
        extraction: DocumentExtraction,
        backend_name: str,
        model_name: str,
    ) -> None:
        field_map = await self._get_custom_field_ids()

        def fv(name: str, value: Any) -> dict | None:
            fid = field_map.get(name)
            if fid is None or value is None:
                return None
            return {"field": fid, "value": value}

        custom_fields = [
            fv(
                "ai_document_type",
                truncate_for_field("ai_document_type", extraction.document_type.value),
            ),
            fv(
                "ai_correspondent",
                truncate_for_field("ai_correspondent", extraction.correspondent),
            ),
            fv(
                "ai_title",
                truncate_for_field("ai_title", extraction.ai_title),
            ),
            fv("ai_issue_date", _normalize_date(extraction.key_dates.issue)),
            fv(
                "ai_reference_numbers",
                truncate_for_field(
                    "ai_reference_numbers",
                    ", ".join(extraction.reference_numbers) or None,
                ),
            ),
            fv(
                "ai_suggested_tags",
                truncate_for_field(
                    "ai_suggested_tags",
                    ", ".join(extraction.suggested_tags) or None,
                ),
            ),
            fv(
                "ai_summary_de",
                truncate_for_field("ai_summary_de", extraction.summary_de),
            ),
            fv("ai_confidence", extraction.confidence),
            fv("ai_backend", truncate_for_field("ai_backend", backend_name)),
            fv("ai_model", truncate_for_field("ai_model", model_name)),
        ]

        resp = await self._client.patch(
            f"/api/documents/{doc_id}/",
            json={"custom_fields": [cf for cf in custom_fields if cf is not None]},
        )
        if resp.status_code >= 400:
            # Paperless validation failures return useful detail in the body —
            # surface it instead of the bare HTTPStatusError that raise_for_status emits.
            log.error(
                "paperless_patch_rejected",
                doc_id=doc_id,
                status=resp.status_code,
                body=resp.text,
            )
        resp.raise_for_status()

    # ------------------------------------------------------------------
    # Documents — propagation helpers
    # ------------------------------------------------------------------

    async def get_documents_with_tag(
        self, tag_name: str, batch_size: int = 5, ordering: str = "modified"
    ) -> list[dict]:
        """Return documents tagged with `tag_name`. Empty list if tag missing.

        `ordering` follows Paperless conventions ("modified" oldest-first,
        "-modified" newest-first, etc.). The list endpoint includes the full
        document including content and custom_fields, so callers do not need
        per-doc GETs to inspect those.
        """
        tag_id = await self._get_tag_id(tag_name)
        if tag_id is None:
            return []
        resp = await self._client.get(
            "/api/documents/",
            params={"tags__id__all": tag_id, "ordering": ordering, "page_size": batch_size},
        )
        resp.raise_for_status()
        return resp.json().get("results", [])

    async def get_custom_field_name_by_id(self) -> dict[int, str]:
        """Inverse of the {name: id} map; useful when reading custom_fields off
        documents returned by list endpoints (each item is {field, value})."""
        return {fid: name for name, fid in (await self._get_custom_field_ids()).items()}

    async def get_entity_name_map(self, endpoint: str) -> dict[int, str]:
        """Return {id: name} for any Paperless entity endpoint with a `name`
        field (correspondents, document_types, tags). Used to resolve foreign
        keys on documents returned by list endpoints."""
        resp = await self._client.get(endpoint, params={"page_size": 200})
        resp.raise_for_status()
        return {x["id"]: x["name"] for x in resp.json().get("results", [])}

    async def get_correspondent_history(
        self, sample_size: int = 200
    ) -> dict[str, dict[str, int]]:
        """Build {correspondent_name: {document_type: count}} from the most
        recent `sample_size` propagated documents. Drives both the per-sender
        prompt hint and any future analytics."""
        docs = await self.get_documents_with_tag(
            "ai-propagated", batch_size=sample_size, ordering="-modified"
        )
        if not docs:
            return {}
        correspondent_names = await self.get_entity_name_map("/api/correspondents/")
        document_type_names = await self.get_entity_name_map("/api/document_types/")
        history: dict[str, dict[str, int]] = {}
        for doc in docs:
            c_id = doc.get("correspondent")
            d_id = doc.get("document_type")
            if c_id is None or d_id is None:
                continue
            c_name = correspondent_names.get(c_id)
            d_name = document_type_names.get(d_id)
            if not c_name or not d_name:
                continue
            history.setdefault(c_name, {}).setdefault(d_name, 0)
            history[c_name][d_name] += 1
        return history

    async def get_ai_custom_field_values(self, doc_id: int) -> dict[str, Any]:
        """Return {field_name: value} for every custom field set on the doc."""
        resp = await self._client.get(f"/api/documents/{doc_id}/")
        resp.raise_for_status()
        doc_data = resp.json()
        name_by_id = {fid: name for name, fid in (await self._get_custom_field_ids()).items()}
        return {
            name_by_id[cf["field"]]: cf.get("value")
            for cf in doc_data.get("custom_fields", [])
            if cf.get("field") in name_by_id
        }

    async def set_error_message(self, doc_id: int, message: str | None) -> None:
        """Write or clear `ai_error_message` on a document.

        Merge-by-id: reads the doc's existing `custom_fields`, drops any prior
        entry for `ai_error_message`, optionally appends the new value, and
        PATCHes the full array back. Paperless's custom_fields PATCH is
        full-array replace (not partial), so a naive single-field PATCH would
        wipe every other ai_* field.

        Best-effort: any failure here is logged but never raised. The caller
        is almost always already handling a primary failure (extraction /
        propagation / indexing); a secondary write failure must not mask it.
        Likewise if the `ai_error_message` custom field hasn't been
        bootstrapped yet (older install), we log + skip.
        """
        try:
            field_map = await self._get_custom_field_ids()
            field_id = field_map.get("ai_error_message")
            if field_id is None:
                log.warning(
                    "ai_error_message_field_missing",
                    doc_id=doc_id,
                    hint="run scripts/bootstrap-paperless.sh to create the field",
                )
                return

            doc = await self.get_document(doc_id)
            existing = list(doc.get("custom_fields") or [])
            merged = [cf for cf in existing if cf.get("field") != field_id]
            if message is not None and message.strip():
                merged.append({"field": field_id, "value": message})

            resp = await self._client.patch(
                f"/api/documents/{doc_id}/",
                json={"custom_fields": merged},
            )
            if resp.status_code >= 400:
                log.error(
                    "ai_error_message_write_failed",
                    doc_id=doc_id,
                    status=resp.status_code,
                    body=resp.text,
                )
        except Exception as exc:  # noqa: BLE001 — best-effort writer
            log.warning(
                "ai_error_message_write_exception", doc_id=doc_id, error=str(exc)
            )

    async def patch_document_native_fields(
        self,
        doc_id: int,
        *,
        correspondent: int | None = None,
        document_type: int | None = None,
        created_date: str | None = None,
        tags: list[int] | None = None,
        title: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {}
        if correspondent is not None:
            payload["correspondent"] = correspondent
        if document_type is not None:
            payload["document_type"] = document_type
        if created_date is not None:
            payload["created_date"] = created_date
        if tags is not None:
            payload["tags"] = tags
        if title is not None:
            payload["title"] = title
        if not payload:
            return
        resp = await self._client.patch(f"/api/documents/{doc_id}/", json=payload)
        if resp.status_code >= 400:
            log.error(
                "paperless_patch_rejected",
                doc_id=doc_id,
                status=resp.status_code,
                body=resp.text,
            )
        resp.raise_for_status()

    # ------------------------------------------------------------------
    # Named entities — tags, correspondents, document types
    # ------------------------------------------------------------------

    async def add_tag_to_document(self, doc_id: int, tag_name: str) -> None:
        tag_id = await self.get_or_create_tag(tag_name)
        doc = await self._client.get(f"/api/documents/{doc_id}/")
        doc.raise_for_status()
        existing_tags: list[int] = doc.json().get("tags", [])
        if tag_id not in existing_tags:
            resp = await self._client.patch(
                f"/api/documents/{doc_id}/",
                json={"tags": existing_tags + [tag_id]},
            )
            resp.raise_for_status()

    async def get_or_create_tag(self, name: str) -> int:
        return await self._get_or_create_named("/api/tags/", name)

    async def get_or_create_correspondent(self, name: str) -> int:
        return await self._get_or_create_named("/api/correspondents/", name)

    async def get_or_create_document_type(self, name: str) -> int:
        return await self._get_or_create_named("/api/document_types/", name)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _get_or_create_named(self, endpoint: str, name: str) -> int:
        """Look up an entity by exact name, creating it if missing.

        Works for any Paperless endpoint whose entities are uniquely identified
        by `name`: tags, correspondents, document_types. We use ?name__iexact=
        because the bare ?name= parameter is silently ignored on /api/tags/
        (it returns the default first page regardless), so once the tag count
        passes one page our exact-match check would not find the existing
        entity and POST would trip the unique-name constraint with a 400.
        The Python-side equality re-check stays as defence in depth.
        """
        resp = await self._client.get(endpoint, params={"name__iexact": name})
        resp.raise_for_status()
        results = resp.json().get("results", [])
        found = next((x["id"] for x in results if x["name"] == name), None)
        if found is not None:
            return found
        resp = await self._client.post(endpoint, json={"name": name})
        if resp.status_code >= 400:
            log.error(
                "paperless_create_rejected",
                endpoint=endpoint,
                name=name,
                status=resp.status_code,
                body=resp.text,
            )
        resp.raise_for_status()
        return resp.json()["id"]

    async def _get_tag_id(self, name: str) -> int | None:
        # See _get_or_create_named for why we must use ?name__iexact= here.
        resp = await self._client.get("/api/tags/", params={"name__iexact": name})
        resp.raise_for_status()
        results = resp.json().get("results", [])
        return next((t["id"] for t in results if t["name"] == name), None)

    async def _get_custom_field_ids(self) -> dict[str, int]:
        resp = await self._client.get("/api/custom_fields/", params={"page_size": 100})
        resp.raise_for_status()
        return {f["name"]: f["id"] for f in resp.json().get("results", [])}
