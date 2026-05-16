"""add answer_llm_quality to app_settings

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-15 00:00:00.000000

Adds a separate quality column for the answer/Q&A step so the user can
pick a smarter model for /ask without changing the tagger model.
Defaults to 'high' — the answer step benefits most from the larger model.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "answer_llm_quality",
            sa.String(16),
            nullable=False,
            server_default="high",
        ),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "answer_llm_quality")
