"""rename llm_quality/answer_llm_quality to llm_model/answer_llm_model

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-19 00:00:00.000000

The app_settings table used to store a symbolic quality tier
("high"/"medium") resolved to an Ollama model tag through a hardcoded
QUALITY_TO_MODEL map in application code. That indirection is retired
in favour of storing the literal model tag directly, so any
locally-pulled Ollama model is selectable without a code change.

This migration renames the columns and widens them (String(16) was
already too narrow for a real tag like "qwen2.5:14b-instruct-q8_0"),
then translates any existing tier value to the concrete model that
tier resolved to at the time this migration was written. Any other
existing value (e.g. an install that already had a literal model tag
hand-set) passes through unchanged.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The QUALITY_TO_MODEL mapping as it existed at the time of this
# migration (both tiers pointed at the same model). Hardcoded here
# rather than imported so this migration keeps describing historical
# state even after settings/quality.py is deleted from the codebase.
_LEGACY_TIER_TO_MODEL = "qwen2.5:14b-instruct-q8_0"


def upgrade() -> None:
    op.alter_column(
        "app_settings",
        "llm_quality",
        new_column_name="llm_model",
        existing_type=sa.String(16),
        type_=sa.String(128),
        server_default=_LEGACY_TIER_TO_MODEL,
    )
    op.alter_column(
        "app_settings",
        "answer_llm_quality",
        new_column_name="answer_llm_model",
        existing_type=sa.String(16),
        type_=sa.String(128),
        server_default=_LEGACY_TIER_TO_MODEL,
    )
    op.execute(
        sa.text(
            "UPDATE app_settings SET llm_model = :model "
            "WHERE llm_model IN ('high', 'medium')"
        ).bindparams(model=_LEGACY_TIER_TO_MODEL)
    )
    op.execute(
        sa.text(
            "UPDATE app_settings SET answer_llm_model = :model "
            "WHERE answer_llm_model IN ('high', 'medium')"
        ).bindparams(model=_LEGACY_TIER_TO_MODEL)
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE app_settings SET llm_model = 'high' "
            "WHERE llm_model NOT IN ('high', 'medium')"
        )
    )
    op.execute(
        sa.text(
            "UPDATE app_settings SET answer_llm_model = 'high' "
            "WHERE answer_llm_model NOT IN ('high', 'medium')"
        )
    )
    op.alter_column(
        "app_settings",
        "llm_model",
        new_column_name="llm_quality",
        existing_type=sa.String(128),
        type_=sa.String(16),
        server_default="high",
    )
    op.alter_column(
        "app_settings",
        "answer_llm_model",
        new_column_name="answer_llm_quality",
        existing_type=sa.String(128),
        type_=sa.String(16),
        server_default="high",
    )
