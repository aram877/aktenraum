from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, Field


def _coerce_str(v: Any) -> str:
    return str(v) if not isinstance(v, str) else v


def _coerce_list(v: Any) -> Any:
    # Small models often emit `null` for empty array fields despite the schema
    # asking for a list. Coerce None → [] so we do not reject extractions over
    # a representation choice that has no semantic meaning here.
    return [] if v is None else v


CoercedStr = Annotated[str, BeforeValidator(_coerce_str)]
CoercedList = Annotated[list[CoercedStr], BeforeValidator(_coerce_list)]

FieldType = Literal["string", "money", "date", "month", "year"]


@dataclass(frozen=True)
class FieldDef:
    name: str
    label_de: str
    field_type: FieldType


class DocumentType(StrEnum):
    Rechnung = "Rechnung"
    Gehaltsabrechnung = "Gehaltsabrechnung"
    Kontoauszug = "Kontoauszug"
    Nebenkostenabrechnung = "Nebenkostenabrechnung"
    Mahnung = "Mahnung"
    Vertrag = "Vertrag"
    Kuendigung = "Kündigung"
    Versicherung = "Versicherung"
    Steuer = "Steuer"
    Bescheid = "Bescheid"
    Behoerdenbrief = "Behördenbrief"
    Sozialversicherungsmeldung = "Sozialversicherungsmeldung"
    Kfz = "Kfz"
    Arztbrief = "Arztbrief"
    Garantie = "Garantie"
    Urkunde = "Urkunde"
    Ausweis = "Ausweis"
    Zeugnis = "Zeugnis"
    Arbeitszeugnis = "Arbeitszeugnis"
    Mitgliedschaft = "Mitgliedschaft"
    Sonstiges = "Sonstiges"


class KeyDates(BaseModel):
    issue: str | None = Field(None, description="Ausstellungsdatum (YYYY-MM-DD)")


class DocumentExtraction(BaseModel):
    document_type: DocumentType = Field(description="Dokumenttyp aus der vorgegebenen Liste")
    correspondent: str | None = Field(None, description="Absender oder Aussteller des Dokuments")
    ai_title: str | None = Field(
        None,
        description=(
            "Prägnanter, sprechender Dokumenttitel auf Deutsch — Typ + Korrespondent "
            "+ optional Datum/Stichwort, max. ~8 Wörter. Beispiel: "
            "'Rechnung Stadtwerke März 2024'."
        ),
    )
    key_dates: KeyDates = Field(default_factory=KeyDates, description="Relevante Datumsangaben")
    monetary_amount: str | None = Field(
        None, description="Geldbetrag mit Währung, z.B. '149,99 EUR'"
    )
    reference_numbers: CoercedList = Field(
        default_factory=list, description="Referenz- oder Vorgangsnummern"
    )
    suggested_tags: CoercedList = Field(
        default_factory=list, description="Empfohlene Schlagwörter"
    )
    summary_de: str = Field(
        default="", description="Kurzzusammenfassung auf Deutsch in genau 3 Sätzen"
    )
    confidence: float = Field(
        default=0.5, ge=0.0, le=1.0, description="Konfidenz der Extraktion (0–1)"
    )
