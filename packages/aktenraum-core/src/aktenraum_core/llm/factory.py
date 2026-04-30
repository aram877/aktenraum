from .anthropic_backend import AnthropicBackend
from .base import LLMBackend
from .ollama_backend import OllamaBackend


def create_backend(
    name: str,
    *,
    anthropic_api_key: str | None = None,
    anthropic_model: str = "claude-sonnet-4-6",
    ollama_base_url: str = "http://localhost:11434",
    ollama_model: str = "llama3.1:8b",
) -> LLMBackend:
    if name == "anthropic":
        if not anthropic_api_key:
            raise ValueError("anthropic_api_key is required when name='anthropic'")
        return AnthropicBackend(api_key=anthropic_api_key, model=anthropic_model)
    if name == "ollama":
        return OllamaBackend(base_url=ollama_base_url, model=ollama_model)
    raise ValueError(f"Unknown LLM backend: {name!r}")
