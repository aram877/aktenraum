from typing import Protocol, runtime_checkable, TypeVar
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


@runtime_checkable
class LLMBackend(Protocol):
    async def complete(self, messages: list[dict], response_schema: type[T]) -> T: ...

    @property
    def name(self) -> str: ...

    @property
    def model(self) -> str: ...
