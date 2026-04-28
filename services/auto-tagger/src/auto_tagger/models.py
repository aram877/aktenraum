from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class DocumentType(str, Enum):
    Rechnung = "Rechnung"
    Vertrag = "Vertrag"
    Behoerdenbrief = "Behördenbrief"
    Versicherung = "Versicherung"
    Mahnung = "Mahnung"
    Kontoauszug = "Kontoauszug"
    Garantie = "Garantie"
    Arztbrief = "Arztbrief"
    Steuer = "Steuer"
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
    reference_numbers: list[str] = Field(default_factory=list, description="Referenz- oder Vorgangsnummern")
    suggested_tags: list[str] = Field(default_factory=list, description="Empfohlene Schlagwörter")
    summary_de: str = Field(description="Kurzzusammenfassung auf Deutsch in genau 3 Sätzen")
    confidence: float = Field(ge=0.0, le=1.0, description="Konfidenz der Extraktion (0–1)")
