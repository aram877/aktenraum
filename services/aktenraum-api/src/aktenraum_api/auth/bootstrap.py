import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from .passwords import hash_password

log = structlog.get_logger()


async def bootstrap_user_if_empty(
    session: AsyncSession, *, username: str, password: str
) -> None:
    """Insert a single user iff the users table is empty AND both creds are non-empty.

    Idempotent: existing users are left alone, so it is safe to call on every
    startup. The env-driven seed is a convenience for first-time setup; subsequent
    password changes happen through the API (future endpoint).
    """
    if not username or not password:
        log.info("bootstrap_skipped_no_creds")
        return
    existing = await session.scalar(select(User).limit(1))
    if existing is not None:
        log.info("bootstrap_skipped_user_exists")
        return
    user = User(username=username, password_hash=hash_password(password))
    session.add(user)
    await session.commit()
    log.info("bootstrap_user_created", username=username)
