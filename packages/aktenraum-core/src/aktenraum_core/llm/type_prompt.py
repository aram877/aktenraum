from __future__ import annotations

import json
import re

import structlog

from ..models.extraction import DocumentType
from ..models.type_schema import TYPE_FIELD_SCHEMA

log = structlog.get_logger()

_FIELD_TYPE_DESCRIPTIONS: dict[str, str] = {
    "string": "Text",
    "money": "Geldbetrag (z.B. '149,99 EUR' oder 'EUR 149.99')",
    "date": "Datum (beliebiges Format — wird normalisiert)",
    "month": "Monat (z.B. '01/2024' oder 'Januar 2024')",
    "year": "Jahr (4-stellig, z.B. '2024')",
}

_OCR_RULE = (
    "Hinweis: OCR-Text kann Ziffern durch Leerzeichen trennen "
    "(z.B. '2 8. 0 2. 2 0 2 4' = '28.02.2024'). "
    "Lies solche Fragmente immer zusammen."
)


def build_type_specific_prompt(doc_type: DocumentType, content: str) -> str:
    fields = TYPE_FIELD_SCHEMA.get(doc_type, [])
    if not fields:
        return ""

    field_lines = "\n".join(
        f"  - {f.name} ({_FIELD_TYPE_DESCRIPTIONS[f.field_type]}): {f.label_de}"
        for f in fields
    )
    null_keys = ", ".join(f'"{f.name}": null' for f in fields)
    example_keys = ", ".join(f'"{f.name}": "..."' for f in fields)

    return (
        f"Du analysierst ein deutsches Dokument vom Typ '{doc_type.value}'.\n"
        f"Extrahiere ausschließlich die folgenden Felder und gib ein JSON-Objekt zurück.\n"
        f"Felder:\n{field_lines}\n\n"
        f"Regeln:\n"
        f"- Antworte NUR mit einem JSON-Objekt, ohne Erklärungen.\n"
        f"- Wenn ein Feld nicht gefunden wird, setze es auf null.\n"
        f"- Beispiel-Antwort (alle null): {{{null_keys}}}\n"
        f"- Beispiel-Antwort (gefüllt): {{{example_keys}}}\n"
        f"- {_OCR_RULE}\n"
    )


async def extract_type_specific(
    doc_type: DocumentType,
    content: str,
    backend: object,
) -> dict[str, str | None]:
    fields = TYPE_FIELD_SCHEMA.get(doc_type, [])
    if not fields:
        return {}

    prompt = build_type_specific_prompt(doc_type, content)
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": f"Dokumenttext:\n\n{content}"},
    ]

    raw: str = await _call_backend(backend, messages)
    raw = _strip_fences(raw)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("type_specific_json_parse_failed", doc_type=doc_type.value, raw=raw[:200])
        return {}

    if not isinstance(parsed, dict):
        return {}

    valid_names = {f.name for f in fields}
    return {
        k: (str(v) if v is not None else None)
        for k, v in parsed.items()
        if k in valid_names
    }


async def _call_backend(backend: object, messages: list[dict]) -> str:
    # Both AnthropicBackend and OllamaBackend expose stream_text for free-form
    # prose. For type-specific extraction we want raw JSON without a Pydantic
    # schema constraint (the schema is implicit in the prompt), so we collect
    # the full stream_text output.
    chunks: list[str] = []
    async for chunk in backend.stream_text(messages):  # type: ignore[union-attr]
        chunks.append(chunk)
    return "".join(chunks)


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("---"):
        text = re.sub(r"^-+", "", text).strip()
    if text.startswith("```"):
        lines = text.splitlines()
        end = len(lines) - 1 if lines[-1].strip() == "```" else len(lines)
        text = "\n".join(lines[1:end])
    return text.strip()
