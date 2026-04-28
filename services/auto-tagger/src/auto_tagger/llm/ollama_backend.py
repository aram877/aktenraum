import json
from typing import TypeVar

import ollama
import structlog
from pydantic import BaseModel, ValidationError

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

        # Inject schema into the system message
        augmented = list(messages)
        for i, msg in enumerate(augmented):
            if msg.get("role") == "system":
                augmented[i] = {
                    "role": "system",
                    "content": msg["content"] + f"\n\nAntworte ausschließlich mit validem JSON gemäß diesem Schema:\n{schema_str}",
                }
                break

        response = await self._client.chat(
            model=self._model,
            messages=augmented,
            format="json",
        )

        raw = response["message"]["content"]
        return response_schema.model_validate_json(raw)
