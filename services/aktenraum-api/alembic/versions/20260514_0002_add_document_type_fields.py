"""add document_type_fields table

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-14 00:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "document_type_fields",
        sa.Column("paperless_doc_id", sa.Integer(), primary_key=True),
        sa.Column("document_type", sa.String(64), nullable=False),
        sa.Column("fields", JSONB(), nullable=False, server_default="{}"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("document_type_fields")
