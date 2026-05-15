import json
from collections.abc import AsyncIterator
from typing import Any, TypeVar

import ollama
import structlog
from pydantic import BaseModel, ValidationError

log = structlog.get_logger()
T = TypeVar("T", bound=BaseModel)

# How many tokens of JSON output the model is allowed to emit. The Ollama
# server default (around 128 for some models, 2 KB for others) routinely
# truncates DocumentExtraction outputs mid-string when summary_de or the
# new confidence_reason field push the body past the limit, surfacing as
# JSONDecodeError("Unterminated string ..."). 4096 is plenty for a
# DocumentExtraction (~1.5 KB of UTF-8) and well within gemma4's 8 K
# default context.
_NUM_PREDICT = 4096

# How many times to retry the chat call on a parse / validation failure.
# Small local models are stochastic — one retry recovers most transient
# truncations. Three attempts in total keeps the worst case bounded.
_MAX_ATTEMPTS = 3


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

        last_error: Exception | None = None
        for attempt in range(_MAX_ATTEMPTS):
            response = await self._client.chat(
                model=self._model,
                messages=augmented,
                format="json",
                options={"num_predict": _NUM_PREDICT},
            )

            raw = response["message"]["content"]
            raw = _clean_json(raw)
            try:
                return self._parse_with_recovery(raw, response_schema)
            except (json.JSONDecodeError, ValidationError) as exc:
                last_error = exc
                # Try to repair before giving up on this attempt — closes
                # unterminated strings and unbalanced braces. When repair
                # produces a different string and that parses cleanly, return.
                repaired = _repair_truncated_json(raw)
                if repaired != raw:
                    try:
                        result = self._parse_with_recovery(repaired, response_schema)
                        log.warning(
                            "ollama_json_repaired",
                            model=self._model,
                            attempt=attempt,
                            kind=type(exc).__name__,
                        )
                        return result
                    except (json.JSONDecodeError, ValidationError) as inner:
                        last_error = inner

                if attempt < _MAX_ATTEMPTS - 1:
                    log.warning(
                        "ollama_json_decode_retrying",
                        model=self._model,
                        attempt=attempt,
                        error=str(exc),
                    )
                    continue
                log.error(
                    "ollama_json_decode_failed",
                    model=self._model,
                    attempts=_MAX_ATTEMPTS,
                    error=str(exc),
                    raw_tail=raw[-200:] if isinstance(raw, str) else None,
                )
                raise

        # Defensive: the loop above either returns or raises; this branch is
        # only reachable if _MAX_ATTEMPTS is 0, which we don't allow.
        assert last_error is not None
        raise last_error

    def _parse_with_recovery(self, raw: str, response_schema: type[T]) -> T:
        """Parse `raw` into `response_schema`, attempting key-recovery for
        models that leak control tokens into JSON keys."""
        try:
            return response_schema.model_validate_json(raw)
        except ValidationError:
            # Some local models (notably the gpt-oss / Harmony family) leak
            # control tokens like `<|channel|>` directly into JSON keys, so
            # we end up with `{"answer_<|channel|>{": "…"}` instead of
            # `{"answer_de": "…"}`. Try to rescue once by renaming garbled
            # keys whose prefix matches a canonical schema field, then
            # re-validate. If that still fails, surface the original error.
            parsed: Any = json.loads(raw)  # let JSONDecodeError bubble
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


def _repair_truncated_json(text: str) -> str:
    """Best-effort repair for JSON that small models truncated mid-string.

    Walks the input once, tracking quote / escape / bracket state. If the
    walk ends inside an unterminated string, we close the string. Then we
    drop any trailing comma after that, and append closing `]` / `}` for
    each unclosed bracket. Returns the input unchanged if no repair was
    needed or if state-walking can't make a safe call.

    This is a heuristic — it tolerates the common "model ran out of
    tokens mid-summary" failure but won't fix structurally broken JSON
    (mismatched braces from earlier, etc.). The caller still validates,
    so a bad repair surfaces the original error.
    """
    if not text:
        return text

    in_string = False
    escape = False
    stack: list[str] = []  # holds "{" / "["
    for ch in text:
        if escape:
            escape = False
            continue
        if ch == "\\" and in_string:
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack and ((stack[-1] == "{" and ch == "}") or (stack[-1] == "[" and ch == "]")):
                stack.pop()
            # else: structural mismatch — bail out of repair, let the
            # caller fail with the original error so we don't paper over
            # actually-broken output.
            else:
                return text

    if not in_string and not stack:
        return text  # already well-formed at the bracket level

    repaired = text
    if in_string:
        repaired += '"'
    # Drop a trailing comma now that the string is closed, so the parser
    # doesn't choke on `…, "field": "value",` after we balance braces.
    repaired = repaired.rstrip()
    if repaired.endswith(","):
        repaired = repaired[:-1]
    for opener in reversed(stack):
        repaired += "}" if opener == "{" else "]"
    return repaired


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
