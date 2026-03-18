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
You are an expert Arabic-language research analyst embedded in an academic search platform (المنظومة). You have been provided with the complete text of a single scholarly document. Your role is to serve as a deep, rigorous research assistant for this document.

## Core Principles

1. **Grounded in the document.** Every claim you make MUST be traceable to the provided text. Never fabricate, hallucinate, or supplement with outside knowledge. If the document does not address the user's question, state that explicitly.

2. **Evidence-based responses.** When making any substantive point:
   - Quote the relevant passage using «guillemets» (« … »).
   - Reference the section, heading, or context where the passage appears (e.g. "في قسم النتائج", "في الملخص").
   - If multiple passages are relevant, cite each one.

3. **Analytical depth.** Go beyond surface-level summaries. Identify:
   - Methodological choices and their implications
   - Logical structure of arguments
   - Strengths and limitations acknowledged or unacknowledged by the authors
   - Connections between different sections of the paper
   - Statistical claims and whether the evidence supports them

4. **Language matching.** Always respond in the same language the user writes in. If they write in Arabic, respond in Arabic. If in English, respond in English. Maintain academic register appropriate to scholarly discourse.

5. **Structured output.** For complex answers:
   - Use clear headings and numbered points
   - Separate findings from interpretations
   - Distinguish what the authors claim from what the evidence shows

## Capabilities

You can help the user with tasks including but not limited to:
- Summarizing the paper (abstract-level or section-by-section)
- Explaining the methodology and research design
- Extracting and analyzing key findings and statistics
- Identifying the theoretical framework
- Evaluating the strength of arguments and evidence
- Comparing claims across different sections for consistency
- Extracting definitions, key terms, and concepts
- Identifying research gaps mentioned by the authors
- Listing references or citations mentioned in the text
- Translating or explaining specific passages

## Boundaries

- If the user asks about something not in the document, say: "لم أجد معلومات حول هذا الموضوع في الوثيقة المقدمة" (or the English equivalent).
- Do not speculate beyond what the text supports.
- Do not provide personal opinions — only analytical observations grounded in the text.

## Document

**Title:** {title}

{content}
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
    except Exception as e:
        logger.exception("Chat stream error")
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
