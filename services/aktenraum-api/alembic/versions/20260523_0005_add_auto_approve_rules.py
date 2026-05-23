"""add auto_approve_rules table seeded with one row per DocumentType

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-23 00:00:00.000000

Replaces the env-var-based AUTO_APPROVE_TYPES / AUTO_APPROVE_CONFIDENCE
gate with a per-DocumentType rule table. Both env vars are READ ONCE
here at migration time: AUTO_APPROVE_CONFIDENCE (default 0.90) seeds
the per-type min_confidence; AUTO_APPROVE_TYPES is only logged at
INFO for the operator's visibility — types are NOT auto-enabled, the
user re-enables via the SPA's Settings page.

The DocumentType enum is duplicated literally in this migration so
the upgrade is stable across future enum changes (a migration must
describe historical state). New enum values land via the startup
reconciler, not migrations.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

log = logging.getLogger("alembic.runtime.migration")

DOCUMENT_TYPES = (
    "Rechnung",
    "Gehaltsabrechnung",
    "Kontoauszug",
    "Nebenkostenabrechnung",
    "Hausgeldabrechnung",
    "Mahnung",
    "Vertrag",
    "Kündigung",
    "Versicherung",
    "Steuer",
    "Lohnsteuerbescheinigung",
    "Spendenbescheinigung",
    "Bescheid",
    "Behördenbrief",
    "Sozialversicherungsmeldung",
    "Kfz",
    "Bußgeldbescheid",
    "Arztbrief",
    "Krankschreibung",
    "Garantie",
    "Urkunde",
    "Ausweis",
    "Zeugnis",
    "Arbeitszeugnis",
    "Mitgliedschaft",
    "Sonstiges",
)


def _resolve_seed_min_confidence() -> str:
    raw = os.environ.get("AUTO_APPROVE_CONFIDENCE", "").strip()
    if not raw:
        return "0.90"
    try:
        value = float(raw)
    except ValueError:
        log.warning(
            "legacy_auto_approve_confidence_invalid value=%r — falling back to 0.90", raw
        )
        return "0.90"
    if not 0.0 <= value <= 1.0:
        log.warning(
            "legacy_auto_approve_confidence_out_of_range value=%r — falling back to 0.90",
            value,
        )
        return "0.90"
    return f"{value:.2f}"


def _log_legacy_types() -> None:
    raw = os.environ.get("AUTO_APPROVE_TYPES", "").strip()
    if not raw:
        return
    parsed = [s.strip() for s in raw.split(",") if s.strip()]
    if parsed:
        log.info(
            "legacy_auto_approve_env_observed types=%s "
            "(NOT auto-enabled — re-enable via SPA Settings)",
            parsed,
        )


def upgrade() -> None:
    op.create_table(
        "auto_approve_rules",
        sa.Column("document_type", sa.String(64), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "min_confidence",
            sa.Numeric(3, 2),
            nullable=False,
            server_default=sa.text("0.90"),
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_by", sa.String(255), nullable=True),
    )

    _log_legacy_types()
    seed_value = _resolve_seed_min_confidence()
    bind = op.get_bind()
    for doc_type in DOCUMENT_TYPES:
        bind.execute(
            sa.text(
                "INSERT INTO auto_approve_rules "
                "(document_type, enabled, min_confidence) "
                "VALUES (:doc_type, :enabled, :min_confidence) "
                "ON CONFLICT (document_type) DO NOTHING"
            ),
            {
                "doc_type": doc_type,
                "enabled": False,
                "min_confidence": seed_value,
            },
        )


def downgrade() -> None:
    op.drop_table("auto_approve_rules")
