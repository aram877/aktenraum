from __future__ import annotations

import time
from typing import Any

import httpx
import structlog

log = structlog.get_logger()


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
