from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
import structlog
from aktenraum_core.paperless.normalisers import (
    _normalize_date,
    _normalize_monetary,
    _truncate_string_field,
)

log = structlog.get_logger()


# Custom-field names whose Paperless data_type drives normalisation. Names
# match what the auto-tagger writes; the inbox PATCH path takes the same shape.
_DATE_FIELDS = frozenset({"ai_issue_date", "ai_due_date", "ai_expiry_date"})
_MONETARY_FIELDS = frozenset({"ai_monetary_amount"})
_FLOAT_FIELDS = frozenset({"ai_confidence"})


class PaperlessGateway:
    """Server-side Paperless client.

    Holds the API token, signs every request, never returns the token to a
    caller. Caches the {correspondent_name: id} map per-process for `ttl_seconds`.
    """

    def __init__(
        self,
        base_url: str,
        api_token: str,
        *,
        ttl_seconds: int = 300,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_token = api_token
        self._ttl_seconds = ttl_seconds
        self._client = client or httpx.AsyncClient(
            base_url=self._base_url,
            headers={"Authorization": f"Token {api_token}"},
            timeout=30.0,
        )
        self._correspondents_cache: tuple[float, dict[str, int]] | None = None
        self._document_types_cache: tuple[float, dict[str, int]] | None = None
        self._tags_cache: tuple[float, dict[str, int]] | None = None
        # Custom-field-id resolver caches; populated lazily on first PATCH.
        self._custom_field_ids: dict[str, int] | None = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def list_correspondents(self) -> dict[str, int]:
        cached = self._read_cache(self._correspondents_cache)
        if cached is not None:
            return cached
        mapping = await self._list_named("/api/correspondents/")
        self._correspondents_cache = (time.monotonic(), mapping)
        return mapping

    async def list_document_types(self) -> dict[str, int]:
        cached = self._read_cache(self._document_types_cache)
        if cached is not None:
            return cached
        mapping = await self._list_named("/api/document_types/")
        self._document_types_cache = (time.monotonic(), mapping)
        return mapping

    async def list_tags(self) -> dict[str, int]:
        cached = self._read_cache(self._tags_cache)
        if cached is not None:
            return cached
        mapping = await self._list_named("/api/tags/")
        self._tags_cache = (time.monotonic(), mapping)
        return mapping

    async def get_document(self, doc_id: int) -> dict:
        resp = await self._client.get(f"/api/documents/{doc_id}/")
        if resp.status_code == 404:
            raise PaperlessNotFoundError(doc_id)
        if resp.status_code in (401, 403):
            raise PaperlessAuthError(resp.status_code)
        resp.raise_for_status()
        return resp.json()

    async def patch_document_custom_fields(
        self, doc_id: int, name_to_value: dict[str, Any]
    ) -> dict[str, Any]:
        """Patch the named ai_* custom fields on a document.

        Paperless's `custom_fields` PATCH is full-array replace, not partial
        upsert — so we read the current array, merge the requested updates by
        field id, and write the merged array back. Without this, patching a
        single field would wipe the other eleven.

        Runs aktenraum-core normalisers (date, monetary, string-trunc) at the
        boundary so a user typing German dates / monetary into the SPA cannot
        trip Paperless's validation. Returns the normalised {name: value} map
        so the SPA can re-render with what was actually written.
        """
        if not name_to_value:
            return {}
        normalised = _normalise_field_values(name_to_value)
        field_ids = await self._get_custom_field_ids()

        update_by_id: dict[int, Any] = {}
        for name, value in normalised.items():
            fid = field_ids.get(name)
            if fid is None:
                log.warning("paperless_unknown_custom_field", name=name)
                continue
            update_by_id[fid] = value
        if not update_by_id:
            return normalised

        existing = await self.get_document(doc_id)
        merged = _merge_custom_fields(
            existing.get("custom_fields") or [], update_by_id
        )
        resp = await self._client.patch(
            f"/api/documents/{doc_id}/", json={"custom_fields": merged}
        )
        if resp.status_code == 404:
            raise PaperlessNotFoundError(doc_id)
        if resp.status_code in (401, 403):
            raise PaperlessAuthError(resp.status_code)
        if resp.status_code >= 400:
            log.error(
                "paperless_patch_rejected",
                doc_id=doc_id,
                status=resp.status_code,
                body=resp.text,
            )
        resp.raise_for_status()
        return normalised

    async def swap_lifecycle_tag(
        self, doc_id: int, *, remove: list[str], add: list[str]
    ) -> list[int]:
        """Replace tags on a document by name.

        Reads the current tag list, plans the swap via `_plan_tag_swap`, sends
        one PATCH with the resulting `tags` array. No-ops when the swap would
        produce an unchanged list (idempotent re-approve / re-reject).
        Returns the resulting tag-id list.
        """
        doc = await self.get_document(doc_id)
        current_ids: list[int] = list(doc.get("tags") or [])
        name_to_id = await self.list_tags()
        new_ids = _plan_tag_swap(
            current_ids=current_ids, name_to_id=name_to_id, remove=remove, add=add
        )
        if new_ids == current_ids:
            return current_ids
        resp = await self._client.patch(
            f"/api/documents/{doc_id}/", json={"tags": new_ids}
        )
        if resp.status_code == 404:
            raise PaperlessNotFoundError(doc_id)
        if resp.status_code in (401, 403):
            raise PaperlessAuthError(resp.status_code)
        if resp.status_code >= 400:
            log.error(
                "paperless_patch_rejected",
                doc_id=doc_id,
                status=resp.status_code,
                body=resp.text,
            )
        resp.raise_for_status()
        return new_ids

    async def stream_preview(self, doc_id: int) -> AsyncIterator[bytes]:
        """Open a streaming GET against Paperless's preview endpoint.

        The caller iterates the bytes (typically inside a StreamingResponse)
        and the underlying httpx response is closed when the iterator is
        exhausted or the consumer aborts.
        """
        async with self._client.stream(
            "GET", f"/api/documents/{doc_id}/preview/"
        ) as resp:
            if resp.status_code == 404:
                raise PaperlessNotFoundError(doc_id)
            if resp.status_code in (401, 403):
                raise PaperlessAuthError(resp.status_code)
            resp.raise_for_status()
            async for chunk in resp.aiter_bytes():
                yield chunk

    async def _get_custom_field_ids(self) -> dict[str, int]:
        if self._custom_field_ids is not None:
            return self._custom_field_ids
        resp = await self._client.get(
            "/api/custom_fields/", params={"page_size": 100}
        )
        if resp.status_code in (401, 403):
            raise PaperlessAuthError(resp.status_code)
        resp.raise_for_status()
        self._custom_field_ids = {
            f["name"]: f["id"] for f in resp.json().get("results", [])
        }
        return self._custom_field_ids

    async def search_documents(self, params: dict[str, Any], *, page_size: int = 100) -> dict:
        """Hit `/api/documents/?...`. Returns the raw paperless payload.

        The caller is responsible for the post-fetch projection / filtering;
        this method stays thin so future callers (review queue, Q&A) can reuse it.
        """
        merged = {"page_size": page_size, **params}
        resp = await self._client.get("/api/documents/", params=merged)
        if resp.status_code in (401, 403):
            log.error("paperless_auth_rejected", status=resp.status_code)
            raise PaperlessAuthError(resp.status_code)
        resp.raise_for_status()
        return resp.json()

    def _read_cache(
        self, entry: tuple[float, dict[str, int]] | None
    ) -> dict[str, int] | None:
        if entry is None:
            return None
        when, value = entry
        if time.monotonic() - when > self._ttl_seconds:
            return None
        return value

    async def _list_named(self, endpoint: str) -> dict[str, int]:
        resp = await self._client.get(endpoint, params={"page_size": 200})
        if resp.status_code in (401, 403):
            raise PaperlessAuthError(resp.status_code)
        resp.raise_for_status()
        return {x["name"]: x["id"] for x in resp.json().get("results", [])}


class PaperlessAuthError(RuntimeError):
    def __init__(self, status: int) -> None:
        super().__init__(f"Paperless rejected the API token (HTTP {status})")
        self.status = status


class PaperlessNotFoundError(RuntimeError):
    def __init__(self, doc_id: int) -> None:
        super().__init__(f"Paperless document {doc_id} not found")
        self.doc_id = doc_id


def _normalise_field_values(name_to_value: dict[str, Any]) -> dict[str, Any]:
    """Apply boundary normalisation per field name.

    Date / monetary fields go through `aktenraum-core` normalisers; string
    fields are truncated to Paperless's 128-char limit. Floats pass through.
    Unknown names pass through unchanged so future fields don't silently
    disappear.
    """
    out: dict[str, Any] = {}
    for name, value in name_to_value.items():
        if value is None:
            out[name] = None
            continue
        if name in _DATE_FIELDS:
            out[name] = _normalize_date(str(value))
            continue
        if name in _MONETARY_FIELDS:
            out[name] = _normalize_monetary(str(value))
            continue
        if name in _FLOAT_FIELDS:
            out[name] = value
            continue
        if isinstance(value, str):
            out[name] = _truncate_string_field(value)
            continue
        out[name] = value
    return out


def _merge_custom_fields(
    existing: list[dict[str, Any]],
    update_by_id: dict[int, Any],
) -> list[dict[str, Any]]:
    """Merge the user's update into the doc's existing custom_fields array.

    Paperless replaces the full array on PATCH, so we preserve the existing
    entries and overwrite only the ones whose field id appears in
    `update_by_id`. Any update for a field id that is not currently on the
    document is appended.
    """
    seen: set[int] = set()
    merged: list[dict[str, Any]] = []
    for cf in existing:
        fid = cf.get("field")
        if fid is None:
            continue
        if fid in update_by_id:
            merged.append({"field": fid, "value": update_by_id[fid]})
            seen.add(fid)
        else:
            merged.append({"field": fid, "value": cf.get("value")})
    for fid, value in update_by_id.items():
        if fid not in seen:
            merged.append({"field": fid, "value": value})
    return merged


def _plan_tag_swap(
    *,
    current_ids: list[int],
    name_to_id: dict[str, int],
    remove: list[str],
    add: list[str],
) -> list[int]:
    """Pure planner for `swap_lifecycle_tag`.

    Removes tag ids whose names match `remove`; appends ids for any name in
    `add` that is not already present. Returns the new tag-id list preserving
    the relative order of surviving ids and appending new ones at the end.
    """
    remove_ids = {name_to_id[name] for name in remove if name in name_to_id}
    surviving = [tid for tid in current_ids if tid not in remove_ids]
    seen = set(surviving)
    for name in add:
        tid = name_to_id.get(name)
        if tid is None or tid in seen:
            continue
        surviving.append(tid)
        seen.add(tid)
    return surviving
