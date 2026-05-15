"""add app_settings table

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-15 00:00:00.000000

Adds a single-row settings table the SPA settings page (and the
auto-tagger) read for the active LLM quality. Seeded with id=1,
llm_quality='high' so installs without explicit user input still
have a well-defined default.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "llm_quality",
            sa.String(16),
            nullable=False,
            server_default="high",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    # Seed the singleton row. ON CONFLICT is defensive for re-runs.
    op.execute(
        "INSERT INTO app_settings (id, llm_quality) VALUES (1, 'high') "
        "ON CONFLICT (id) DO NOTHING"
    )


def downgrade() -> None:
    op.drop_table("app_settings")
