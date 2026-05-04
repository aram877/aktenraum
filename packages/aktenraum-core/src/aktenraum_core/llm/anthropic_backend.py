from collections.abc import AsyncIterator
from typing import TypeVar

import anthropic
import structlog
from pydantic import BaseModel

log = structlog.get_logger()
T = TypeVar("T", bound=BaseModel)


_STREAM_MAX_TOKENS = 1024


class AnthropicBackend:
    def __init__(self, api_key: str, model: str = "claude-sonnet-4-6") -> None:
        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        self._model = model

    @property
    def name(self) -> str:
        return "anthropic"

    @property
    def model(self) -> str:
        return self._model

    async def complete(self, messages: list[dict], response_schema: type[T]) -> T:
        schema = response_schema.model_json_schema()
        tool_def = {
            "name": "extract_document",
            "description": "Extrahiert strukturierte Metadaten aus dem Dokument.",
            "input_schema": schema,
        }

        response = await self._client.messages.create(
            model=self._model,
            max_tokens=1024,
            tools=[tool_def],
            tool_choice={"type": "tool", "name": "extract_document"},
            messages=messages,
        )

        for block in response.content:
            if block.type == "tool_use" and block.name == "extract_document":
                return response_schema.model_validate(block.input)

        raise ValueError("Anthropic response contained no tool_use block")

    async def stream_text(self, messages: list[dict]) -> AsyncIterator[str]:
        """Stream prose deltas via Anthropic's messages.stream API.

        Splits a system message off the front (Anthropic takes `system` as a
        kwarg, not a role) so callers can keep using the OpenAI-style message
        list shape end-to-end.
        """
        system, user_messages = _split_system(messages)
        kwargs: dict = {
            "model": self._model,
            "max_tokens": _STREAM_MAX_TOKENS,
            "messages": user_messages,
        }
        if system:
            kwargs["system"] = system
        async with self._client.messages.stream(**kwargs) as stream:
            async for text in stream.text_stream:
                if text:
                    yield text


def _split_system(messages: list[dict]) -> tuple[str | None, list[dict]]:
    """Pull the first system message out; return it plus the rest verbatim.

    Anthropic rejects `role: "system"` inside the messages array — system
    prompts must travel as the top-level `system` kwarg. The OpenAI-style
    callers we have in the codebase put the prompt as a system role, so this
    adapter normalises that shape.
    """
    system: str | None = None
    rest: list[dict] = []
    for msg in messages:
        if msg.get("role") == "system" and system is None:
            system = msg.get("content", "")
            continue
        rest.append(msg)
    return system, rest
