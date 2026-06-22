from datetime import datetime
from decimal import Decimal

from sqlalchemy import JSON, Boolean, DateTime, Integer, Numeric, String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class DocumentTypeFields(Base):
    __tablename__ = "document_type_fields"

    paperless_doc_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    document_type: Mapped[str] = mapped_column(String(64), nullable=False)
    fields: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class AppSettings(Base):
    """Single-row table holding runtime-mutable application settings.

    Pinned to id=1 — the service inserts a default row at startup if
    missing and only ever updates that one row. SPA settings page reads /
    writes via the /api/settings endpoints; the auto-tagger and the
    aktenraum-api LLM deps read from this row instead of taking
    OLLAMA_MODEL at startup, so the operator can switch models without
    recreating containers.
    """

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # "high"/"medium" → an Ollama model tag (see settings/quality.py). Stored as the symbolic
    # quality name (not the model tag) so we can swap the underlying
    # models later without a migration.
    llm_quality: Mapped[str] = mapped_column(String(16), nullable=False, default="high")
    # Quality tier for the answer/Q&A step (/api/ai/answer). Defaults to
    # "high" so the answer model is the more capable one out of the box.
    answer_llm_quality: Mapped[str] = mapped_column(String(16), nullable=False, default="high")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class AutoApproveRuleRow(Base):
    """Per-DocumentType auto-approve rule.

    One row per `aktenraum_core.models.DocumentType` enum value (26 in
    total). `enabled` and `min_confidence` together drive the auto-tagger
    routing decision — see `auto_tagger.tagger._route_lifecycle_tags`.
    Seeded by the Alembic migration; a startup reconciler inserts any
    missing rows so adding a new DocumentType enum value never requires
    a manual migration.
    """

    __tablename__ = "auto_approve_rules"

    document_type: Mapped[str] = mapped_column(String(64), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    min_confidence: Mapped[Decimal] = mapped_column(
        Numeric(3, 2), nullable=False, default=Decimal("0.90")
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
