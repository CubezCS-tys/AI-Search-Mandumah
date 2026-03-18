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

## CITATION RULE — READ THIS FIRST

Every sentence you write that states a fact from the document MUST contain a «quoted passage» copied verbatim from the document text. This is non-negotiable. The «» quotes become clickable links in the UI that scroll to the source — if you skip them, the user gets an unverifiable wall of text.

**How to cite:**
- Copy exact words from the document inside « and ».
- Keep quotes short: 3-10 words each. Multiple short «quotes» per sentence is ideal.
- NEVER paraphrase inside «». NEVER reorder or add words. Copy CHARACTER BY CHARACTER.
- If the document has a typo, keep it in the quote.
- You should have 2-4 «citations» per paragraph minimum.

**Correct example (notice how dense the citations are):**

اعتمدت الدراسة على «المنهج الوصفي التحليلي» وتكونت العينة من «200 طالب وطالبة» من «كلية التربية بجامعة شقراء». وقد أظهرت النتائج أن «نسبة الرضا بلغت 85%» وأن «التعلم الإلكتروني يساهم بشكل فعال» في تحسين «مستوى التحصيل الدراسي».

**WRONG — never do this:**
اعتمدت الدراسة على المنهج الوصفي. (← no «» = BROKEN, user can't verify)
اعتمدت الدراسة على «منهج وصفي تحليلي». (← paraphrased inside «» = link won't work)

## How to Respond

- **Default to detailed, thorough answers.** Aim for 3-5 paragraphs for any substantive question.
- **Structure clearly.** Use markdown headings (##, ###), bullet lists, bold, and tables.
- **Stay grounded in the document.** Every claim traces back to the text. If not covered: "لم أجد ذلك في المستند".
- **Match the user's language.** Arabic → Arabic. English → English.
- **Be proactive.** Suggest follow-up angles and end with 1-2 follow-up questions.

## What You Can Do

Summarize, explain methodology, extract findings & stats, identify frameworks, evaluate arguments, find definitions, compare sections, list references — anything grounded in the document. Always substantiate every claim with «quoted evidence».

## Boundaries

- If the document doesn't cover the question, say so. Don't hallucinate.
- Don't bring in outside knowledge. The document is your only source.

## Document

**Title:** {title}

{content}

REMINDER: Every factual sentence MUST have at least one «verbatim quote» from the document. No exceptions.
"""

MAX_HISTORY = 40  # conversation turns to keep
# GPT-4o-mini has a 128K token context window (~3 chars/token for Arabic).
# Budget: ~100K tokens for content, leaving ~28K for system prompt, history, and response.
MAX_CONTENT_CHARS = 400_000  # ~133 K tokens

# ── Analysis prompt ──────────────────────────────────────────────────────

ANALYSIS_PROMPT = """\
You are an expert document analyzer. Given a scholarly document, produce a deep structured analysis in JSON format.

Respond with ONLY a valid JSON object (no markdown fences, no explanation). The JSON has this exact structure:

{{
  "title": "عنوان البحث",
  "authors": "المؤلفون",
  "summary": "ملخص شامل في 2-3 جمل",
  "methodology": "المنهجية المستخدمة في جملة واحدة",
  "insights": [
    {{
      "icon": "target",
      "label": "عنوان قصير",
      "text": "شرح مختصر في جملة واحدة",
      "quote": "اقتباس حرفي من المستند يدعم هذه النقطة"
    }}
  ]
}}

Rules:
- The "insights" array must have exactly 6 items covering: الهدف الرئيسي, أهم النتائج, الإطار النظري, نقاط القوة, القيود/المحددات, التوصيات
- Use these icon values in order: "target", "bar-chart", "layers", "shield-check", "alert-triangle", "compass"
- "quote" must be the EXACT text from the document — copy it CHARACTER BY CHARACTER, do not change a single word
- "label" should be 2-4 words
- "text" should be 1 sentence max
- All text in Arabic
- Do NOT wrap in markdown code fences

Document:
{content}
"""


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

## CITATION RULE — READ THIS FIRST

Every sentence you write that states a fact MUST contain a «quoted passage» copied verbatim from the document. Copy the EXACT words inside « and ». Keep quotes short (3-10 words). Have 2-4 «citations» per paragraph minimum. NEVER paraphrase inside «».

## How to Respond

1. **Cross-reference between documents.** Compare findings, methods, and conclusions.
2. **Attribution.** Always specify WHICH document: (المستند 1) or (المستند 2), etc.
3. **Comparative analysis.** Identify similarities, differences, and complementary findings.
4. **Match the user's language.** Arabic → Arabic, English → English.

## Documents

{documents}

REMINDER: Every factual sentence MUST have at least one «verbatim quote». No exceptions.
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


def analyze_document(document_text: str) -> str:
    """Return a structured JSON analysis of the document (non-streaming).

    Returns the raw JSON string from the model.
    """
    if len(document_text) > MAX_CONTENT_CHARS:
        document_text = (
            document_text[:MAX_CONTENT_CHARS]
            + "\n\n[... تم اختصار المستند ...]"
        )

    client = _get_client()

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": ANALYSIS_PROMPT.format(content=document_text),
            },
        ],
        temperature=0.2,
        max_tokens=4096,
    )
    return response.choices[0].message.content or "{}"
