import re
from datetime import datetime
from typing import Any

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


def _truncate_string_field(value: str | None) -> str | None:
    if value is None:
        return None
    if len(value) <= _PAPERLESS_STRING_MAX:
        return value
    return value[: _PAPERLESS_STRING_MAX - 1] + "…"


# Paperless's `date` custom field requires strict YYYY-MM-DD; the LLM mostly
# obeys the system prompt but occasionally emits German DD.MM.YYYY or partial
# month-year values. We try a small set of common formats and drop the field
# (return None) if none parse — better to lose a date than fail the whole PATCH.
_DATE_FORMATS = (
    "%Y-%m-%d",
    "%d.%m.%Y",
    "%d/%m/%Y",
    "%Y/%m/%d",
    "%d.%m.%y",
    "%m.%Y",  # German month-year (e.g. "12.2024") → falls through, see below
    "%m/%Y",
    "%Y-%m",  # ISO month-year
)


def _normalize_date(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    for fmt in _DATE_FORMATS:
        try:
            parsed = datetime.strptime(text, fmt)
        except ValueError:
            continue
        # For month-year-only formats, anchor the day to the 1st so Paperless
        # still gets a valid date. Acceptable approximation for documents that
        # only specify a month (e.g. Lohnsteuerbescheinigung "12-2024").
        return parsed.strftime("%Y-%m-%d")
    return None


def _normalize_monetary(value: str | None) -> str | None:
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

    code: str | None = None
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
            fv("ai_document_type", _truncate_string_field(extraction.document_type.value)),
            fv("ai_correspondent", _truncate_string_field(extraction.correspondent)),
            fv("ai_issue_date", _normalize_date(extraction.key_dates.issue)),
            fv("ai_due_date", _normalize_date(extraction.key_dates.due)),
            fv("ai_expiry_date", _normalize_date(extraction.key_dates.expiry)),
            fv("ai_monetary_amount", _normalize_monetary(extraction.monetary_amount)),
            fv(
                "ai_reference_numbers",
                _truncate_string_field(", ".join(extraction.reference_numbers) or None),
            ),
            fv(
                "ai_suggested_tags",
                _truncate_string_field(", ".join(extraction.suggested_tags) or None),
            ),
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

    async def patch_document_native_fields(
        self,
        doc_id: int,
        *,
        correspondent: int | None = None,
        document_type: int | None = None,
        created_date: str | None = None,
        tags: list[int] | None = None,
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
