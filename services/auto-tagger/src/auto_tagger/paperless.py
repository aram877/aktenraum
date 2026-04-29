from typing import Any, Optional

import httpx
import structlog

from .models import DocumentExtraction

log = structlog.get_logger()


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
        """Return documents that have neither ai-suggested nor ai-error tags."""
        ai_suggested_id = await self._get_tag_id("ai-suggested")
        ai_error_id = await self._get_tag_id("ai-error")

        # Build a tag exclusion filter — Paperless API supports tags__id__none
        exclude_ids = ",".join(str(i) for i in [ai_suggested_id, ai_error_id] if i is not None)
        params: dict[str, Any] = {"ordering": "created", "page_size": batch_size}
        if exclude_ids:
            params["tags__id__none"] = exclude_ids

        resp = await self._client.get("/api/documents/", params=params)
        resp.raise_for_status()
        return resp.json().get("results", [])

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

        def fv(name: str, value: Any) -> Optional[dict]:
            fid = field_map.get(name)
            if fid is None or value is None:
                return None
            return {"field": fid, "value": value}

        custom_fields = [
            fv("ai_document_type", extraction.document_type.value),
            fv("ai_correspondent", extraction.correspondent),
            fv("ai_issue_date", extraction.key_dates.issue),
            fv("ai_due_date", extraction.key_dates.due),
            fv("ai_expiry_date", extraction.key_dates.expiry),
            fv("ai_monetary_amount", extraction.monetary_amount),
            fv("ai_reference_numbers", ", ".join(extraction.reference_numbers) or None),
            fv("ai_suggested_tags", ", ".join(extraction.suggested_tags) or None),
            fv("ai_summary_de", extraction.summary_de),
            fv("ai_confidence", extraction.confidence),
            fv("ai_backend", backend_name),
            fv("ai_model", model_name),
        ]

        resp = await self._client.patch(
            f"/api/documents/{doc_id}/",
            json={"custom_fields": [cf for cf in custom_fields if cf is not None]},
        )
        resp.raise_for_status()

    # ------------------------------------------------------------------
    # Tags
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
        tag_id = await self._get_tag_id(name)
        if tag_id is not None:
            return tag_id
        resp = await self._client.post("/api/tags/", json={"name": name})
        resp.raise_for_status()
        return resp.json()["id"]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _get_tag_id(self, name: str) -> Optional[int]:
        resp = await self._client.get("/api/tags/", params={"name": name})
        resp.raise_for_status()
        results = resp.json().get("results", [])
        # Paperless may do substring matching — filter for exact name match
        return next((t["id"] for t in results if t["name"] == name), None)

    async def _get_custom_field_ids(self) -> dict[str, int]:
        resp = await self._client.get("/api/custom_fields/", params={"page_size": 100})
        resp.raise_for_status()
        return {f["name"]: f["id"] for f in resp.json().get("results", [])}
