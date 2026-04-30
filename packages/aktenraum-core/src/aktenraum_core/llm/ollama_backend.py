import json
from typing import TypeVar

import ollama
import structlog
from pydantic import BaseModel

log = structlog.get_logger()
T = TypeVar("T", bound=BaseModel)


class OllamaBackend:
    def __init__(self, base_url: str, model: str = "llama3.1:8b") -> None:
        self._client = ollama.AsyncClient(host=base_url)
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
        return response_schema.model_validate_json(raw)


def _clean_json(text: str) -> str:
    """Strip YAML document markers and markdown code fences that some models prepend."""
    text = text.strip()
    if text.startswith("---"):
        text = text.lstrip("-").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    return text.strip()
