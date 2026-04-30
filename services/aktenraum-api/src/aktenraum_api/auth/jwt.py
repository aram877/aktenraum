from datetime import UTC, datetime, timedelta

import jwt

_ALG = "HS256"


def create_token(user_id: int, *, secret: str, expires_seconds: int) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=expires_seconds)).timestamp()),
    }
    return jwt.encode(payload, secret, algorithm=_ALG)


def verify_token(token: str, *, secret: str) -> int | None:
    """Return the user_id encoded in `sub`, or None if the token is invalid/expired."""
    try:
        payload = jwt.decode(token, secret, algorithms=[_ALG])
    except jwt.PyJWTError:
        return None
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub.isdigit():
        return None
    return int(sub)
