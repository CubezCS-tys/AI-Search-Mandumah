"""
Document-scoped chat using GPT-4o-mini.

Loads the full document text into the system prompt and streams
a grounded response via the OpenAI API.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Generator

from openai import OpenAI

logger = logging.getLogger(__name__)

# ── System prompt ─────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are a helpful research assistant analyzing an Arabic academic article.
You have been given the full text of the document below.

## Rules
- Answer based ONLY on the document provided. Do not use outside knowledge.
- If the answer is not in the document, say so clearly.
- When citing, quote the relevant Arabic text using «guillemets» and note the section if known.
- Respond in the same language the user writes in.
- Be concise but thorough.

## Document
Title: {title}

{content}
"""

MAX_HISTORY = 40  # conversation turns to keep


# ── Lazy OpenAI client ────────────────────────────────────────────────────

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY environment variable is not set")
        _client = OpenAI(api_key=api_key)
    return _client


# ── Public API ────────────────────────────────────────────────────────────


def stream_chat(
    document_text: str,
    message: str,
    history: list[dict[str, str]],
) -> Generator[str, None, None]:
    """Yield SSE-formatted token chunks for a document-grounded chat.

    Args:
        document_text: Full ``content`` field from the Azure DI JSON.
        message: The new user question.
        history: Previous ``[{"role": "user"|"assistant", "content": "..."}]``.

    Yields:
        SSE lines: ``data: {"token": "..."}`` and finally ``data: [DONE]``.
    """
    title = document_text[:200].split("\n")[0] if document_text else "Unknown"
    system = SYSTEM_PROMPT.format(title=title, content=document_text)

    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    for msg in history[-MAX_HISTORY:]:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": message})

    client = _get_client()

    try:
        stream = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            stream=True,
            temperature=0.3,
            max_tokens=2048,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta
            if delta.content:
                yield f"data: {json.dumps({'token': delta.content})}\n\n"
        yield "data: [DONE]\n\n"
    except Exception as e:
        logger.exception("Chat stream error")
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
