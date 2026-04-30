import re
from typing import Any, Optional

import httpx
import structlog

from .models import DocumentExtraction

log = structlog.get_logger()


# Tags that mark a document as having entered the AI pipeline. The auto-tagger
# excludes documents carrying any of these from its unprocessed-doc query, and
# the propagator filters by individual states (ai-approved, ai-propagated, …).
LIFECYCLE_TAGS = (
    "ai-pending",
    "ai-approved",
    "ai-rejected",
    "ai-propagated",
    "ai-propagation-error",
    "ai-error",
)


_CURRENCY_CODES = ("EUR", "USD", "GBP", "CHF", "JPY")
_CURRENCY_SYMBOLS = {"€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY"}

# Paperless `string` custom fields are backed by a 128-char DB column. Anything
# longer is rejected with a 400. We truncate with an ellipsis so the PATCH still
# succeeds; a richer storage model (e.g. Paperless notes for summary_de) is a
# separate piece of work.
_PAPERLESS_STRING_MAX = 128


def _truncate_string_field(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if len(value) <= _PAPERLESS_STRING_MAX:
        return value
    return value[: _PAPERLESS_STRING_MAX - 1] + "…"


def _normalize_monetary(value: Optional[str]) -> Optional[str]:
    """Convert a freeform monetary string to Paperless format (e.g. 'EUR149.99').

    Paperless's `monetary` custom field requires a 3-letter ISO code prefix and
    dot-decimal amount. The LLM emits German-style formats like '149,99 EUR'.
    Returns None if parsing fails (the field is then dropped from the PATCH).
    """
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None

    code: Optional[str] = None
    upper = text.upper()
    for c in _CURRENCY_CODES:
        if c in upper:
            code = c
            break
    if code is None:
        for sym, c in _CURRENCY_SYMBOLS.items():
            if sym in text:
                code = c
                break
    if code is None:
        code = "EUR"

    num_str = re.sub(r"[^\d.,\-]", "", text)
    if not num_str:
        return None

    # Disambiguate decimal separator. Both present: the rightmost is the
    # decimal (handles "1.234,56" German and "1,234.56" Anglophone).
    if "," in num_str and "." in num_str:
        if num_str.rfind(",") > num_str.rfind("."):
            num_str = num_str.replace(".", "").replace(",", ".")
        else:
            num_str = num_str.replace(",", "")
    elif "," in num_str:
        num_str = num_str.replace(",", ".")

    try:
        amount = float(num_str)
    except ValueError:
        return None
    return f"{code}{amount:.2f}"


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
            fv("ai_document_type", _truncate_string_field(extraction.document_type.value)),
            fv("ai_correspondent", _truncate_string_field(extraction.correspondent)),
            fv("ai_issue_date", extraction.key_dates.issue),
            fv("ai_due_date", extraction.key_dates.due),
            fv("ai_expiry_date", extraction.key_dates.expiry),
            fv("ai_monetary_amount", _normalize_monetary(extraction.monetary_amount)),
            fv("ai_reference_numbers", _truncate_string_field(", ".join(extraction.reference_numbers) or None)),
            fv("ai_suggested_tags", _truncate_string_field(", ".join(extraction.suggested_tags) or None)),
            fv("ai_summary_de", _truncate_string_field(extraction.summary_de)),
            fv("ai_confidence", extraction.confidence),
            fv("ai_backend", _truncate_string_field(backend_name)),
            fv("ai_model", _truncate_string_field(model_name)),
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

    async def get_documents_with_tag(self, tag_name: str, batch_size: int = 5) -> list[dict]:
        """Return documents tagged with `tag_name`. Empty list if tag missing."""
        tag_id = await self._get_tag_id(tag_name)
        if tag_id is None:
            return []
        resp = await self._client.get(
            "/api/documents/",
            params={"tags__id__all": tag_id, "ordering": "modified", "page_size": batch_size},
        )
        resp.raise_for_status()
        return resp.json().get("results", [])

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

    async def patch_document_native_fields(
        self,
        doc_id: int,
        *,
        correspondent: Optional[int] = None,
        document_type: Optional[int] = None,
        created_date: Optional[str] = None,
        tags: Optional[list[int]] = None,
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
        by `name`: tags, correspondents, document_types. The lookup defends
        against Paperless's fuzzy ?name= filter by re-checking equality on the
        client.
        """
        resp = await self._client.get(endpoint, params={"name": name})
        resp.raise_for_status()
        results = resp.json().get("results", [])
        found = next((x["id"] for x in results if x["name"] == name), None)
        if found is not None:
            return found
        resp = await self._client.post(endpoint, json={"name": name})
        resp.raise_for_status()
        return resp.json()["id"]

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
