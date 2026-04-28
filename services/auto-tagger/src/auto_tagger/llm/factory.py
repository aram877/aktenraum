from ..config import Settings
from .anthropic_backend import AnthropicBackend
from .base import LLMBackend
from .ollama_backend import OllamaBackend


def create_backend(settings: Settings) -> LLMBackend:
    if settings.llm_backend == "anthropic":
        return AnthropicBackend(api_key=settings.anthropic_api_key, model=settings.anthropic_model)
    if settings.llm_backend == "ollama":
        return OllamaBackend(base_url=settings.ollama_base_url, model=settings.ollama_model)
    raise ValueError(f"Unknown LLM_BACKEND: {settings.llm_backend!r}")
