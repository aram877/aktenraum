from enum import Enum
from typing import Annotated, Any, Optional

from pydantic import BaseModel, BeforeValidator, Field


def _coerce_str(v: Any) -> str:
    return str(v) if not isinstance(v, str) else v


CoercedStr = Annotated[str, BeforeValidator(_coerce_str)]


class DocumentType(str, Enum):
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
    issue: Optional[str] = Field(None, description="Ausstellungsdatum (YYYY-MM-DD)")
    due: Optional[str] = Field(None, description="Fälligkeitsdatum (YYYY-MM-DD)")
    expiry: Optional[str] = Field(None, description="Ablaufdatum (YYYY-MM-DD)")


class DocumentExtraction(BaseModel):
    document_type: DocumentType = Field(description="Dokumenttyp aus der vorgegebenen Liste")
    correspondent: Optional[str] = Field(None, description="Absender oder Aussteller des Dokuments")
    key_dates: KeyDates = Field(default_factory=KeyDates, description="Relevante Datumsangaben")
    monetary_amount: Optional[str] = Field(None, description="Geldbetrag mit Währung, z.B. '149,99 EUR'")
    reference_numbers: list[CoercedStr] = Field(default_factory=list, description="Referenz- oder Vorgangsnummern")
    suggested_tags: list[CoercedStr] = Field(default_factory=list, description="Empfohlene Schlagwörter")
    summary_de: str = Field(description="Kurzzusammenfassung auf Deutsch in genau 3 Sätzen")
    confidence: float = Field(ge=0.0, le=1.0, description="Konfidenz der Extraktion (0–1)")
