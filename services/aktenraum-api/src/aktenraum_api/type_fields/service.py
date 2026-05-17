from __future__ import annotations

import re

import structlog
from aktenraum_core.models import TYPE_FIELD_SCHEMA, DocumentType
from aktenraum_core.paperless.normalisers import _normalize_date, _normalize_monetary
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import DocumentTypeFields
from ..paperless_gw import PaperlessGateway

log = structlog.get_logger()


async def get(session: AsyncSession, doc_id: int) -> DocumentTypeFields | None:
    result = await session.get(DocumentTypeFields, doc_id)
    return result


async def upsert(
    session: AsyncSession,
    gateway: PaperlessGateway,
    doc_id: int,
    raw_fields: dict[str, str | None],
    doc_type_str: str | None = None,
) -> DocumentTypeFields:
    if doc_type_str is None:
        doc_type_str = await _infer_document_type(gateway, doc_id)

    doc_type = _parse_doc_type(doc_type_str)
    schema_fields = TYPE_FIELD_SCHEMA.get(doc_type, []) if doc_type else []
    field_type_map = {f.name: f.field_type for f in schema_fields}

    normalised: dict[str, str] = {}
    for name, value in raw_fields.items():
        if value is None:
            continue
        ft = field_type_map.get(name, "string")
        cleaned = _normalise_value(name, value, ft)
        if cleaned is not None:
            normalised[name] = cleaned

    row = await session.get(DocumentTypeFields, doc_id)
    if row is None:
        row = DocumentTypeFields(
            paperless_doc_id=doc_id,
            document_type=doc_type_str or "",
            fields=normalised,
        )
        session.add(row)
    else:
        merged = dict(row.fields or {})
        # Drop fields from the previous type when the type has changed so
        # stale keys don't accumulate across type switches.
        if doc_type_str and row.document_type and row.document_type != doc_type_str:
            merged = {k: v for k, v in merged.items() if k in field_type_map}
        merged.update(normalised)
        row.fields = merged
        if doc_type_str:
            row.document_type = doc_type_str

    await session.commit()
    await session.refresh(row)
    return row


async def _infer_document_type(gateway: PaperlessGateway, doc_id: int) -> str | None:
    try:
        doc = await gateway.get_document(doc_id)
        name_to_id = await gateway._get_custom_field_ids()  # noqa: SLF001
        field_id_to_name = {fid: name for name, fid in name_to_id.items()}
        for cf in doc.get("custom_fields") or []:
            if field_id_to_name.get(cf.get("field")) == "ai_document_type":
                return cf.get("value") or None
    except Exception as exc:
        log.warning("type_fields_infer_doc_type_failed", doc_id=doc_id, error=str(exc))
    return None


def _parse_doc_type(value: str | None) -> DocumentType | None:
    if not value:
        return None
    try:
        return DocumentType(value)
    except ValueError:
        return None


def _normalise_value(name: str, value: str, field_type: str) -> str | None:
    value = value.strip()
    if not value:
        return None
    if field_type == "money":
        return _normalize_monetary(value) or value
    if field_type == "date":
        return _normalize_date(value) or value
    if field_type == "month":
        return _normalise_month(value)
    if field_type == "year":
        digits = re.sub(r"\D", "", value)
        return digits[:4] if len(digits) >= 4 else value
    # string — truncate at 500 chars
    return value[:500]


def _normalise_month(value: str) -> str:
    value = value.strip()
    # Already YYYY-MM
    if re.match(r"^\d{4}-\d{2}$", value):
        return value
    # MM/YYYY or MM.YYYY
    m = re.match(r"^(\d{1,2})[./](\d{4})$", value)
    if m:
        return f"{m.group(2)}-{m.group(1).zfill(2)}"
    # German month names
    _MONTHS_DE = {
        "januar": "01", "februar": "02", "märz": "03", "maerz": "03",
        "april": "04", "mai": "05", "juni": "06", "juli": "07",
        "august": "08", "september": "09", "oktober": "10",
        "november": "11", "dezember": "12",
    }
    lower = value.lower()
    for name, num in _MONTHS_DE.items():
        if name in lower:
            year_match = re.search(r"\d{4}", value)
            if year_match:
                return f"{year_match.group()}-{num}"
    return value


def validate_field_names(
    doc_type_str: str | None,
    raw_fields: dict[str, str | None],
) -> list[str]:
    """Return list of unknown field names for the given document type."""
    doc_type = _parse_doc_type(doc_type_str)
    if doc_type is None:
        return []
    schema_fields = TYPE_FIELD_SCHEMA.get(doc_type, [])
    valid = {f.name for f in schema_fields}
    return [name for name in raw_fields if name not in valid]
