import json
from typing import TypeVar

import anthropic
import structlog
from pydantic import BaseModel

log = structlog.get_logger()
T = TypeVar("T", bound=BaseModel)


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
