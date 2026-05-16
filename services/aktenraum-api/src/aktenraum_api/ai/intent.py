"""Lightweight keyword classifier over the user's German question.

Returns the set of `Intent` values that the keywords trigger; downstream
code maps intents to `DocumentType` values via `INTENT_DOC_TYPES`. Used by
the filter prompt to inject typed few-shot examples — the answer prompt
drives off `candidates` directly and does not need this.

Pure function, no I/O. Deliberately conservative: false positives are
worse than false negatives here because every extra example adds tokens.
A miss falls through to the static few-shots, which still work for the
common shapes.
"""

from __future__ import annotations

import re
from enum import StrEnum

from aktenraum_core.models import DocumentType


class Intent(StrEnum):
    SALARY = "salary"
    SPENDING = "spending"
    TAX = "tax"
    INSURANCE = "insurance"
    HOUSING = "housing"
    MEDICAL = "medical"
    ID_DOCUMENT = "id_document"
    CAR = "car"
    CONTRACT = "contract"


# Substring match by default — German compounds bury the keyword anywhere
# in the word ("Mietvertrag" contains "vertrag", "Steuererstattung"
# contains "steuer"), so word-boundary-anchored matching misses most of
# the natural phrasing. Short / ambiguous keywords (`pass` collides with
# "Passwort", `lohn` collides with "lohnen") opt into strict
# whole-word matching via `_STRICT_KEYWORDS`.
_INTENT_KEYWORDS: dict[Intent, tuple[str, ...]] = {
    Intent.SALARY: (
        "verdien",  # verdient, verdiene, verdienen
        "gehalt",  # Gehalt, Gehaltsabrechnung, Bruttogehalt, Nettogehalt
        "gehälter",
        "lohnabrechnung",
        "lohn",  # strict — see _STRICT_KEYWORDS
        "nettolohn",
        "bruttolohn",
        "auszahlung",
    ),
    Intent.SPENDING: (
        "ausgegeben",
        "kosten",  # Kosten, kostet, kostspielig, Kostenvoranschlag
        "gekostet",
        "bezahlt",
        "preis",
        "rechnung",
    ),
    Intent.TAX: (
        "steuer",  # Steuer, Steuererstattung, Steuerbescheid, Lohnsteuer
        "erstattung",
        "finanzamt",
    ),
    Intent.INSURANCE: (
        "versicherung",
        "prämie",
        "police",
        "selbstbeteiligung",
        "schadensfall",
    ),
    Intent.HOUSING: (
        "nebenkosten",
        "hausgeld",
        "miete",  # Miete, Mieter, Mietvertrag
        "vorauszahlung",
    ),
    Intent.MEDICAL: (
        "arzt",
        "diagnose",
        "krankschreibung",
        "krank",  # krank, krankgeschrieben
        "au-bescheinigung",
        "arbeitsunfähig",
        "befund",
        "rezept",
    ),
    Intent.ID_DOCUMENT: (
        "reisepass",
        "ausweis",  # Ausweis, Personalausweis
        "perso",  # Perso, Personalausweis
        "führerschein",
        "fuehrerschein",
        "ablauf",  # Ablauf, läuft ab (partial), Ablaufdatum
        "abläuft",
        "verlängern",
        "verlaengern",
        "gültig",
        "pass",  # strict — see _STRICT_KEYWORDS
    ),
    Intent.CAR: (
        "kfz",
        "tüv",
        "tuev",
        "hauptuntersuchung",
        "kennzeichen",
        "fahrgestell",
        "fahrgestellnummer",
        "fahrzeug",
    ),
    Intent.CONTRACT: (
        "vertrag",  # Vertrag, Mietvertrag, Arbeitsvertrag
        "kündigung",
        "kuendigung",
        "kündigen",
        "vertragsende",
    ),
}

# Keywords that need strict whole-word matching to avoid noise. Short or
# polysemic words go here. Word boundaries on both sides via `\b<kw>\b`.
_STRICT_KEYWORDS: frozenset[str] = frozenset({"pass", "lohn"})


# Maps each intent to the doc types it implies. An intent may bind to
# more than one type — e.g. SPENDING is ambiguous between Rechnung and
# Mahnung; INTENT_DOC_TYPES surfaces both, the modules' `filter_examples`
# disambiguate by example pattern.
INTENT_DOC_TYPES: dict[Intent, tuple[DocumentType, ...]] = {
    Intent.SALARY: (DocumentType.Gehaltsabrechnung,),
    Intent.SPENDING: (DocumentType.Rechnung, DocumentType.Mahnung),
    Intent.TAX: (DocumentType.Steuer, DocumentType.Lohnsteuerbescheinigung),
    Intent.INSURANCE: (DocumentType.Versicherung,),
    Intent.HOUSING: (
        DocumentType.Nebenkostenabrechnung,
        DocumentType.Hausgeldabrechnung,
    ),
    Intent.MEDICAL: (DocumentType.Arztbrief, DocumentType.Krankschreibung),
    Intent.ID_DOCUMENT: (DocumentType.Ausweis,),
    Intent.CAR: (DocumentType.Kfz,),
    Intent.CONTRACT: (DocumentType.Vertrag, DocumentType.Kuendigung),
}


def detect_intents(question: str) -> set[Intent]:
    """Return the set of intents that the question's keywords trigger.

    Word-boundary matched on the lowercased question. Multi-token keywords
    (e.g. "au-bescheinigung") are matched by literal substring instead
    because `\\b` does not treat `-` as a word character.
    """
    if not question:
        return set()
    lowered = question.lower()
    hits: set[Intent] = set()
    for intent, keywords in _INTENT_KEYWORDS.items():
        for kw in keywords:
            if _matches(lowered, kw):
                hits.add(intent)
                break
    return hits


def doc_types_for_intents(intents: set[Intent]) -> list[DocumentType]:
    """Flatten intents → ordered list of doc types, preserving INTENT_DOC_TYPES order.

    Deduplicated. Intent order is iteration order of the set (non-deterministic)
    so we resort against the `Intent` enum to keep the output stable across
    runs — small but matters for prompt-cache hit rates.
    """
    out: list[DocumentType] = []
    seen: set[DocumentType] = set()
    for intent in Intent:
        if intent not in intents:
            continue
        for dt in INTENT_DOC_TYPES.get(intent, ()):
            if dt in seen:
                continue
            seen.add(dt)
            out.append(dt)
    return out


def _matches(haystack: str, keyword: str) -> bool:
    """Match `keyword` in `haystack` (already lowercased).

    - Strict keywords (`_STRICT_KEYWORDS`) use `\\b<kw>\\b` so short
      ambiguous words like "pass" do not trigger on "passwort".
    - All other keywords use plain substring match so German compounds
      ("Mietvertrag" → vertrag, "Steuererstattung" → steuer) work
      without per-keyword listing of every compound form.
    """
    if keyword in _STRICT_KEYWORDS:
        return re.search(rf"\b{re.escape(keyword)}\b", haystack) is not None
    return keyword in haystack
