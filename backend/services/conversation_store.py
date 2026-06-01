"""
SQLite-backed persistence for corpus-wide chat conversations.

Uses only the Python standard library (``sqlite3``). A single module-level
connection is opened lazily with ``check_same_thread=False`` and guarded by a
``Lock`` so it is safe to use from FastAPI's threadpool / async workers.

Schema:
    conversations(id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT)
    messages(id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT,
             sources_json TEXT, created_at TEXT,
             FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE)
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_DB_PATH = "./storage/conversations.db"

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def _now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    """Return a fresh uuid4 hex id."""
    return uuid.uuid4().hex


def _db_path() -> Path:
    return Path(os.getenv("CHAT_DB_PATH", _DEFAULT_DB_PATH))


def _get_conn() -> sqlite3.Connection:
    """Return the lazily-initialised, thread-safe SQLite connection."""
    global _conn
    if _conn is None:
        with _lock:
            if _conn is None:
                path = _db_path()
                path.parent.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(str(path), check_same_thread=False)
                conn.row_factory = sqlite3.Row
                # ── Production / multi-worker safety ──────────────────────
                # Each uvicorn worker is a separate process with its own
                # connection; the in-process Lock cannot coordinate writes
                # across processes. WAL lets multiple processes read while one
                # writes (instead of the default exclusive-lock journal), and
                # busy_timeout makes a worker wait-and-retry for the write lock
                # rather than immediately raising "database is locked".
                conn.execute("PRAGMA journal_mode = WAL")
                conn.execute("PRAGMA synchronous = NORMAL")
                conn.execute("PRAGMA busy_timeout = 5000")
                conn.execute("PRAGMA foreign_keys = ON")
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS conversations (
                        id TEXT PRIMARY KEY,
                        title TEXT,
                        created_at TEXT,
                        updated_at TEXT
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS messages (
                        id TEXT PRIMARY KEY,
                        conversation_id TEXT,
                        role TEXT,
                        content TEXT,
                        sources_json TEXT,
                        created_at TEXT,
                        FOREIGN KEY(conversation_id)
                            REFERENCES conversations(id) ON DELETE CASCADE
                    )
                    """
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_messages_conversation "
                    "ON messages(conversation_id, created_at)"
                )
                conn.commit()
                _conn = conn
                logger.info("Conversation store initialised at %s", path)
    return _conn


# ── Public API ────────────────────────────────────────────────────────────


def create_conversation(title: str) -> str:
    """Create a new conversation and return its id."""
    conv_id = _new_id()
    now = _now_iso()
    conn = _get_conn()
    with _lock:
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (conv_id, title, now, now),
        )
        conn.commit()
    return conv_id


def add_message(
    conversation_id: str,
    role: str,
    content: str,
    sources: list[dict[str, Any]] | None = None,
) -> str:
    """Append a message to a conversation and bump ``updated_at``.

    Returns the new message id.
    """
    msg_id = _new_id()
    now = _now_iso()
    sources_json = json.dumps(sources, ensure_ascii=False) if sources else None
    conn = _get_conn()
    with _lock:
        conn.execute(
            "INSERT INTO messages "
            "(id, conversation_id, role, content, sources_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (msg_id, conversation_id, role, content, sources_json, now),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (now, conversation_id),
        )
        conn.commit()
    return msg_id


def get_conversation(conversation_id: str) -> dict[str, Any] | None:
    """Return a conversation with its ordered messages, or None if missing."""
    conn = _get_conn()
    with _lock:
        conv_row = conn.execute(
            "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()
        if conv_row is None:
            return None
        msg_rows = conn.execute(
            "SELECT id, role, content, sources_json, created_at "
            "FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        ).fetchall()

    messages: list[dict[str, Any]] = []
    for row in msg_rows:
        sources = json.loads(row["sources_json"]) if row["sources_json"] else None
        messages.append(
            {
                "id": row["id"],
                "role": row["role"],
                "content": row["content"],
                "sources": sources,
                "created_at": row["created_at"],
            }
        )

    return {
        "id": conv_row["id"],
        "title": conv_row["title"],
        "created_at": conv_row["created_at"],
        "updated_at": conv_row["updated_at"],
        "messages": messages,
    }


def list_conversations() -> list[dict[str, Any]]:
    """Return all conversations (most-recently-updated first) with a preview."""
    conn = _get_conn()
    with _lock:
        conv_rows = conn.execute(
            "SELECT id, title, updated_at FROM conversations "
            "ORDER BY updated_at DESC"
        ).fetchall()
        previews: dict[str, str] = {}
        for row in conv_rows:
            msg = conn.execute(
                "SELECT content FROM messages "
                "WHERE conversation_id = ? AND role = 'user' "
                "ORDER BY created_at ASC LIMIT 1",
                (row["id"],),
            ).fetchone()
            if msg and msg["content"]:
                text = msg["content"].strip()
                previews[row["id"]] = text[:120] + ("…" if len(text) > 120 else "")
            else:
                previews[row["id"]] = ""

    return [
        {
            "id": row["id"],
            "title": row["title"],
            "updated_at": row["updated_at"],
            "preview": previews.get(row["id"], ""),
        }
        for row in conv_rows
    ]


def rename_conversation(conversation_id: str, title: str) -> bool:
    """Rename a conversation. Returns True if a row was updated."""
    now = _now_iso()
    conn = _get_conn()
    with _lock:
        cur = conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (title, now, conversation_id),
        )
        conn.commit()
        return cur.rowcount > 0


def delete_conversation(conversation_id: str) -> bool:
    """Delete a conversation and its messages. Returns True if it existed."""
    conn = _get_conn()
    with _lock:
        cur = conn.execute(
            "DELETE FROM conversations WHERE id = ?", (conversation_id,)
        )
        # Explicit cleanup in case PRAGMA foreign_keys is not honoured.
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?", (conversation_id,)
        )
        conn.commit()
        return cur.rowcount > 0


def update_timestamp(conversation_id: str) -> None:
    """Touch a conversation's ``updated_at`` to the current time."""
    now = _now_iso()
    conn = _get_conn()
    with _lock:
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (now, conversation_id),
        )
        conn.commit()
