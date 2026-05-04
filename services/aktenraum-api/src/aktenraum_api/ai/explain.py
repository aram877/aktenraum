"""German one-sentence explanation of a SearchFilter.

Used both for LLM-built filters (after extraction) and SPA-edited filters,
so the explanation is regenerated on every /api/ai/ask call rather than
baked into the LLM response.
"""

from __future__ import annotations

from .schemas import SearchFilter


def explain_filter(f: SearchFilter) -> str:
    parts: list[str] = []
    if f.document_type is not None:
        parts.append(f"Dokumenttyp '{f.document_type.value}'")
    if f.correspondent:
        parts.append(f"Korrespondent '{f.correspondent}'")
    if f.date_from is not None and f.date_to is not None:
        parts.append(f"Zeitraum {f.date_from.isoformat()} bis {f.date_to.isoformat()}")
    elif f.date_from is not None:
        parts.append(f"ab {f.date_from.isoformat()}")
    elif f.date_to is not None:
        parts.append(f"bis {f.date_to.isoformat()}")
    if f.min_amount is not None and f.max_amount is not None:
        parts.append(f"Betrag zwischen {_fmt(f.min_amount)}€ und {_fmt(f.max_amount)}€")
    elif f.min_amount is not None:
        parts.append(f"Betrag mindestens {_fmt(f.min_amount)}€")
    elif f.max_amount is not None:
        parts.append(f"Betrag höchstens {_fmt(f.max_amount)}€")
    if f.text:
        parts.append(f"Stichwort '{f.text}'")
    if f.tags:
        joined = ", ".join(f"'{t}'" for t in f.tags)
        parts.append(f"Tags {joined}")

    if not parts:
        return "Ich habe verstanden: keine Einschränkungen."
    return "Ich habe verstanden: " + ", ".join(parts) + "."


def _fmt(amount: float) -> str:
    return f"{amount:.2f}".replace(".", ",").rstrip("0").rstrip(",")
