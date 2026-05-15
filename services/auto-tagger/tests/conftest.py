import pytest


@pytest.fixture
def make_settings(monkeypatch):
    """Settings factory: set required env vars, return a fresh Settings.

    Usage: `settings = make_settings(AUTO_APPROVE_TYPES="Rechnung")` overrides
    just that var. Reasonable defaults are supplied for everything else so
    each test stays focused on the field it cares about.
    """

    def _make(**overrides):
        defaults = {
            "PAPERLESS_BASE_URL": "http://x",
            "PAPERLESS_API_TOKEN": "x",
            "LLM_BACKEND": "ollama",
            "AUTO_APPROVE_CONFIDENCE": "0.90",
            "AUTO_APPROVE_TYPES": "",
            "LOW_CONFIDENCE_THRESHOLD": "0.6",
            "FEW_SHOT_EXAMPLES": "0",
        }
        defaults.update({k: str(v) for k, v in overrides.items()})
        for k, v in defaults.items():
            monkeypatch.setenv(k, v)
        from auto_tagger.config import Settings

        return Settings()

    return _make
