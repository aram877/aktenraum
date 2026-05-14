import json
from collections.abc import AsyncIterator
from typing import Any, TypeVar

import ollama
import structlog
from pydantic import BaseModel, ValidationError

log = structlog.get_logger()
T = TypeVar("T", bound=BaseModel)


class OllamaBackend:
    def __init__(self, base_url: str, model: str = "llama3.1:8b", timeout: float = 120.0) -> None:
        self._client = ollama.AsyncClient(host=base_url, timeout=timeout)
        self._model = model

    @property
    def name(self) -> str:
        return "ollama"

    @property
    def model(self) -> str:
        return self._model

    async def complete(self, messages: list[dict], response_schema: type[T]) -> T:
        schema = response_schema.model_json_schema()
        schema_str = json.dumps(schema, ensure_ascii=False, indent=2)

        augmented = list(messages)
        schema_instruction = (
            "\n\nAntworte ausschließlich mit validem JSON gemäß diesem Schema:\n"
            f"{schema_str}"
        )
        for i, msg in enumerate(augmented):
            if msg.get("role") == "system":
                augmented[i] = {
                    "role": "system",
                    "content": msg["content"] + schema_instruction,
                }
                break

        response = await self._client.chat(
            model=self._model,
            messages=augmented,
            format="json",
        )

        raw = response["message"]["content"]
        raw = _clean_json(raw)
        try:
            return response_schema.model_validate_json(raw)
        except ValidationError:
            # Some local models (notably the gpt-oss / Harmony family) leak
            # control tokens like `<|channel|>` directly into JSON keys, so
            # we end up with `{"answer_<|channel|>{": "…"}` instead of
            # `{"answer_de": "…"}`. Try to rescue once by renaming garbled
            # keys whose prefix matches a canonical schema field, then
            # re-validate. If that still fails, surface the original error.
            try:
                parsed: Any = json.loads(raw)
            except json.JSONDecodeError:
                raise
            recovered = _recover_keys_for_schema(parsed, response_schema)
            if recovered is parsed:
                raise
            log.warning(
                "ollama_json_keys_recovered",
                model=self._model,
                original_keys=sorted(parsed.keys()) if isinstance(parsed, dict) else None,
            )
            return response_schema.model_validate(recovered)


    async def stream_text(self, messages: list[dict]) -> AsyncIterator[str]:
        """Stream a prose response chunk-by-chunk.

        No `format="json"` here — this path is intentionally unstructured so
        the model's natural-language output flows through Paperless tokens
        rather than getting blocked behind JSON-mode tokenization. The caller
        is expected to apply any post-hoc parsing (e.g. matching `Dokument N`
        ids) after the stream completes.
        """
        stream = await self._client.chat(
            model=self._model,
            messages=messages,
            stream=True,
        )
        async for chunk in stream:
            content = chunk.get("message", {}).get("content", "")
            if content:
                yield content


def _clean_json(text: str) -> str:
    """Strip YAML document markers and markdown code fences that some models prepend."""
    text = text.strip()
    if text.startswith("---"):
        text = text.lstrip("-").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    return text.strip()


def _recover_keys_for_schema(parsed: Any, schema: type[BaseModel]) -> Any:
    """Best-effort rename of garbled top-level keys to canonical schema names.

    Heuristic: when a canonical schema field is missing AND exactly one sibling
    key shares the same first underscore-segment as that field (e.g. "answer_de"
    and "answer_<|channel|>{" both start with "answer"), rename the sibling.
    Returns a new dict on rescue, or the original `parsed` value when nothing
    can be recovered (so the caller can detect a no-op).
    """
    if not isinstance(parsed, dict):
        return parsed
    fields = schema.model_fields
    out = dict(parsed)
    changed = False
    for canonical in fields:
        if canonical in out:
            continue
        prefix = canonical.split("_", 1)[0]
        candidates = [
            k
            for k in out
            if isinstance(k, str)
            and k != canonical
            and k.split("_", 1)[0] == prefix
            and k not in fields  # don't poach a different valid field name
        ]
        if len(candidates) == 1:
            out[canonical] = out.pop(candidates[0])
            changed = True
    return out if changed else parsed
