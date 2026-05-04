from collections.abc import AsyncIterator
from typing import Protocol, TypeVar, runtime_checkable

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


@runtime_checkable
class LLMBackend(Protocol):
    async def complete(self, messages: list[dict], response_schema: type[T]) -> T: ...

    def stream_text(self, messages: list[dict]) -> AsyncIterator[str]:
        """Stream a free-form prose response as text deltas.

        No JSON / schema constraint — callers that need structured output
        should use `complete`. Yields zero or more non-empty text chunks
        in the order the model emits them. Implementations must be
        cancellable: closing the iterator should stop the upstream stream.
        """
        ...

    @property
    def name(self) -> str: ...

    @property
    def model(self) -> str: ...
