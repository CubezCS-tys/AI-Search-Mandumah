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
You are a smart, helpful research assistant embedded in an academic search platform called المنظومة. You have the complete text of a scholarly document below.

## How to Respond

- **Be conversational and natural.** Talk like a knowledgeable colleague, not a textbook. Be warm, clear, and concise. Match the user's energy — short questions get short answers, deep questions get thorough analysis.
- **Stay grounded in the document.** Every claim must trace back to the text. If something isn't covered, say so honestly: "لم أجد ذلك في المستند" and move on.
- **Quote key passages with «guillemets».** This is mandatory — every factual claim needs at least one «quoted passage» from the document. These quotes become clickable links that take the user to the source in the document.
- **Match the user's language.** Arabic question → Arabic answer. English → English. Mix → your best judgment.
- **Use markdown formatting** (headings, lists, bold, tables) to structure longer answers, but keep short answers concise — no need to over-format a simple response.
- **Be proactive.** Suggest follow-up angles, highlight interesting patterns, or point out connections the user might want to explore.

## Citation Format (CRITICAL)

You MUST wrap every direct quote in «guillemets» (« »). This is how the citation system works — quotes inside «» become clickable links in the UI.

**Rules:**
- Quote the EXACT words from the document. Do not paraphrase inside «».
- Prefer short, precise quotes (5-15 words) over long paragraphs. Multiple short quotes are better than one huge quote.
- Every paragraph of your response should have at least one «quoted phrase».
- You can have multiple «quotes» in a single sentence.

**Example:**

يوضح الباحث أن «التعلم الإلكتروني يساهم بشكل فعال في تحسين مستوى التحصيل الدراسي» وأن «نسبة الرضا بلغت 85% بين المشاركين». كما يشير إلى أن «المنهج المستخدم هو المنهج الوصفي التحليلي» في إطار دراسة شملت «عينة مكونة من 200 طالب».

## What You Can Do

Summarize, explain methodology, extract findings & stats, identify frameworks, evaluate arguments, find definitions, compare sections, list references, translate passages — anything grounded in the document.

## Boundaries

- If the document doesn't cover the question, say so. Don't guess or hallucinate.
- Don't bring in outside knowledge. The document is your only source.

## Document

**Title:** {title}

{content}

REMINDER: Always use «guillemets» (« ») around quoted passages from the document.
"""

MAX_HISTORY = 40  # conversation turns to keep
# GPT-4o-mini has a 128K token context window (~4 chars/token for Arabic).
# Budget: ~100K tokens for content, leaving ~28K for system prompt, history, and response.
MAX_CONTENT_CHARS = 400_000  # ~100 K tokens


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

MULTI_DOC_SYSTEM_PROMPT = """\
You are a smart, helpful research assistant on المنظومة. You have the complete text of MULTIPLE scholarly documents below for comparison and cross-analysis.

## How to Respond

Same conversational, grounded approach as single-document mode, plus:

1. **Cross-reference between documents.** Compare findings, methods, and conclusions across all documents.
2. **Attribution.** Always specify WHICH document: (المستند 1) or (المستند 2), etc.
3. **Comparative analysis.** Identify similarities, differences, and complementary findings.
4. **Match the user's language.** Arabic → Arabic, English → English.
5. **MANDATORY «guillemet» citations.** Quote the EXACT words from the documents inside «guillemets». Prefer short, precise quotes (5-15 words). Multiple short «quotes» per paragraph. Never skip the «» marks.

Be conversational, be helpful, be specific.

## Documents

{documents}
"""


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
    # Truncate very long documents to avoid exceeding the model's context window
    if len(document_text) > MAX_CONTENT_CHARS:
        document_text = (
            document_text[:MAX_CONTENT_CHARS]
            + "\n\n[... تم اختصار المستند لأن حجمه يتجاوز الحد المسموح به ...]"
        )
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
            max_tokens=16384,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta
            if delta.content:
                yield f"data: {json.dumps({'token': delta.content})}\n\n"
        yield "data: [DONE]\n\n"
    except Exception:
        logger.exception("Chat stream error")
        yield f"data: {json.dumps({'error': 'حدث خطأ أثناء معالجة طلبك. يرجى المحاولة مرة أخرى.'})}\n\n"


def stream_chat_multi(
    primary_text: str,
    compare_docs: list[tuple[str, str]],
    message: str,
    history: list[dict[str, str]],
) -> Generator[str, None, None]:
    """Stream chat for multi-document comparison mode.

    Args:
        primary_text: Full content of the primary document.
        compare_docs: List of (doc_id, content) for comparison documents.
        message: The new user question.
        history: Previous conversation turns.
    """
    # Budget per document: split evenly
    total_docs = 1 + len(compare_docs)
    per_doc_chars = MAX_CONTENT_CHARS // total_docs

    def truncate(text: str, limit: int) -> str:
        if len(text) > limit:
            return text[:limit] + "\n\n[... تم اختصار المستند ...]"
        return text

    title1 = primary_text[:200].split("\n")[0] if primary_text else "Unknown"
    docs_section = f"### المستند 1 (الأساسي): {title1}\n\n{truncate(primary_text, per_doc_chars)}\n\n"

    for idx, (doc_id, content) in enumerate(compare_docs, start=2):
        title = content[:200].split("\n")[0] if content else doc_id
        docs_section += f"### المستند {idx}: {title}\n\n{truncate(content, per_doc_chars)}\n\n"

    system = MULTI_DOC_SYSTEM_PROMPT.format(documents=docs_section)

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
            max_tokens=16384,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta
            if delta.content:
                yield f"data: {json.dumps({'token': delta.content})}\n\n"
        yield "data: [DONE]\n\n"
    except Exception:
        logger.exception("Multi-doc chat stream error")
        yield f"data: {json.dumps({'error': 'حدث خطأ أثناء معالجة طلبك. يرجى المحاولة مرة أخرى.'})}\n\n"
