"""
Lightweight username/password auth for the admin console (`/api/admin/*`).

Designed for a single operator exposing the API on a public port: a single
admin credential pair plus HMAC-signed, self-contained bearer tokens. No
database, no session store, no extra dependencies (stdlib only).

Environment variables
---------------------
ADMIN_USER       Admin username (default: "admin").
ADMIN_PASSWORD   Admin password (default: "admin" — CHANGE THIS in production).
ADMIN_SECRET     Token-signing secret. If unset, it is derived deterministically
                 from ADMIN_PASSWORD so tokens survive process restarts AND are
                 automatically invalidated whenever the password changes.
ADMIN_TOKEN_TTL  Token lifetime in seconds (default: 43200 = 12h).

Token format: ``base64url(payload_json).base64url(hmac_sha256(secret, body))``
where payload is ``{"sub": <user>, "exp": <unix_ts>}``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time

logger = logging.getLogger(__name__)

ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin")
TOKEN_TTL = int(os.getenv("ADMIN_TOKEN_TTL", str(12 * 60 * 60)))


def _signing_secret() -> bytes:
    """Return the HMAC signing key.

    Prefers an explicit ``ADMIN_SECRET``; otherwise derives a stable key from
    the password so (a) tokens survive restarts and (b) rotating the password
    transparently invalidates every previously issued token.
    """
    explicit = os.getenv("ADMIN_SECRET")
    if explicit:
        return explicit.encode("utf-8")
    return hashlib.sha256(f"manthooma-admin::{ADMIN_PASSWORD}".encode("utf-8")).digest()


if ADMIN_PASSWORD == "admin":
    logger.warning(
        "ADMIN_PASSWORD is using the insecure default 'admin'. "
        "Set ADMIN_PASSWORD (and ideally ADMIN_SECRET) before exposing /api/admin."
    )


# ── Credential check ──────────────────────────────────────────────────────


def check_credentials(username: str, password: str) -> bool:
    """Constant-time check of submitted credentials against the admin pair."""
    user_ok = hmac.compare_digest((username or "").encode("utf-8"), ADMIN_USER.encode("utf-8"))
    pass_ok = hmac.compare_digest((password or "").encode("utf-8"), ADMIN_PASSWORD.encode("utf-8"))
    return user_ok and pass_ok


# ── Token mint / verify ───────────────────────────────────────────────────


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def make_token(username: str, ttl: int = TOKEN_TTL) -> str:
    """Mint a signed bearer token for *username* valid for *ttl* seconds."""
    payload = {"sub": username, "exp": int(time.time()) + ttl}
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(_signing_secret(), body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64e(sig)}"


def verify_token(token: str) -> str | None:
    """Return the token's subject if valid and unexpired, else ``None``."""
    if not token or "." not in token:
        return None
    body, _, sig = token.partition(".")
    expected = hmac.new(_signing_secret(), body.encode("ascii"), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(expected, _b64d(sig)):
            return None
        payload = json.loads(_b64d(body))
    except Exception:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload.get("sub")
