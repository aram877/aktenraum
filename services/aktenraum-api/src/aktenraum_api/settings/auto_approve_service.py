from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import structlog
from aktenraum_core.models import AutoApproveRule, DocumentType
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AutoApproveRuleRow
from .auto_approve_schemas import AutoApproveRulesUpdateRequest

log = structlog.get_logger()

DEFAULT_MIN_CONFIDENCE = Decimal("0.90")


def _row_to_model(row: AutoApproveRuleRow) -> AutoApproveRule:
    return AutoApproveRule(
        document_type=DocumentType(row.document_type),
        enabled=row.enabled,
        min_confidence=float(row.min_confidence),
        updated_at=row.updated_at,
        updated_by=row.updated_by,
    )


async def list_rules(session: AsyncSession) -> list[AutoApproveRule]:
    """Return all 26 rules, sorted alphabetically by document_type."""
    stmt = select(AutoApproveRuleRow).order_by(AutoApproveRuleRow.document_type)
    result = await session.execute(stmt)
    return [_row_to_model(row) for row in result.scalars().all()]


async def replace_rules(
    session: AsyncSession,
    payload: AutoApproveRulesUpdateRequest,
    updated_by: str,
) -> list[AutoApproveRule]:
    """Apply a full-set replacement. All 26 rows are updated to match the
    payload; updated_at/updated_by are stamped on each."""
    by_type = {entry.document_type: entry for entry in payload.rules}
    stmt = select(AutoApproveRuleRow)
    result = await session.execute(stmt)
    rows = {row.document_type: row for row in result.scalars().all()}
    now = datetime.now(UTC)
    for doc_type, entry in by_type.items():
        row = rows.get(doc_type.value)
        if row is None:
            row = AutoApproveRuleRow(document_type=doc_type.value)
            session.add(row)
        row.enabled = entry.enabled
        row.min_confidence = Decimal(f"{entry.min_confidence:.2f}")
        row.updated_at = now
        row.updated_by = updated_by
    await session.commit()
    return await list_rules(session)


async def reconcile_missing_rules(session: AsyncSession) -> int:
    """Insert a row for any DocumentType that doesn't have one yet.

    Runs at app startup so adding a new enum value never requires a
    schema migration. Idempotent: never UPDATEs or DELETEs. Returns the
    number of inserted rows (0 in the steady state)."""
    stmt = select(AutoApproveRuleRow.document_type)
    result = await session.execute(stmt)
    existing = {row for row in result.scalars().all()}
    expected = {dt.value for dt in DocumentType}
    missing = expected - existing
    if not missing:
        return 0
    for doc_type in sorted(missing):
        session.add(
            AutoApproveRuleRow(
                document_type=doc_type,
                enabled=False,
                min_confidence=DEFAULT_MIN_CONFIDENCE,
            )
        )
    await session.commit()
    log.info("auto_approve_rules_reconciled", inserted=len(missing))
    return len(missing)
