"""
Cross-document synthesis for search results.

Takes the top retrieved chunks and synthesises a grounded, cited answer
to the user's query. Every claim MUST be attributed to a source chunk.
Streams SSE tokens identical to services/chat.py.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Generator

from openai import OpenAI

logger = logging.getLogger(__name__)

_SYNTHESIS_SYSTEM_PROMPT = """\
أنت محلل بحثي أكاديمي متخصص مدمج في منصة المنظومة الأكاديمية.

[تعليمات داخلية — لا تُضمَّن في الإجابة]
- اكتب `(م N)` مباشرةً بعد كل جملة موضوعية، حيث N رقم المستند من القائمة أدناه.
- استخرج كل ما له صلة حتى لو كان التطابق غير مباشر.
- لا تختلق أرقاماً أو نتائج — اقتصر على ما في المقتطفات.
- لا تُدرج قائمة مراجع أو أرقام المصادر في نهاية الإجابة.
- إن تجاوز السؤال نطاق المصادر، قدّم ما وجدته ثم أشر للفجوة باختصار.
[نهاية التعليمات الداخلية]

اكتب إجابتك بالهيكل التالي حرفياً، دون أي إضافات قبله أو بعده:

### نظرة عامة موحدة
اربط المصادر المتاحة حول الموضوع: عدد الدراسات وطبيعتها وسياقها الأكاديمي العام. \
كل جملة موضوعية تنتهي بـ`(م N)`.

### المنهجيات والعينات
المناهج البحثية (وصفي/تجريبي/مسحي...)، أحجام العينات بالأرقام الدقيقة، أدوات الدراسة، \
الفروق المنهجية بين الدراسات. مرجع لكل معلومة.

### النتائج الرئيسية والإحصاءات
الأرقام والنسب والقيم الإحصائية المسحوبة مباشرةً من النصوص. \
قارن بين نتائج الدراسات. مرجع لكل رقم.

### التوافق والتعارض
أين تتفق المصادر وأين تختلف؟ عرض التعارضات صراحةً مع ذكر المصادر المتعارضة.

### فجوات البحث والتوصيات
ما أشارت إليه المصادر من حاجة للمزيد، وما لم تغطِّه المصادر المتاحة. \
اقترح محاور بحثية مستقبلية.

---
المقتطفات المُسترجعة:
{chunks}
"""

_MAX_CHUNK_CHARS = 1500  # chars per chunk shown to synthesiser


def stream_synthesis(
    query: str,
    chunks: list[dict],
) -> Generator[str, None, None]:
    """Stream a cross-document synthesis grounded in retrieved chunks.

    Args:
        query: The original user search query.
        chunks: List of dicts with keys: doc_id, title, section, text, score.
                Expected to be pre-ranked (index 0 = best).

    Yields:
        SSE-formatted strings: ``data: {"token": "..."}\\n\\n``
        Final: ``data: [DONE]\\n\\n``
        On error: ``data: {"error": "..."}\\n\\n``
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        yield f"data: {json.dumps({'error': 'OPENAI_API_KEY not configured'})}\n\n"
        return

    # Build the numbered chunks block shown to the model
    chunks_text = ""
    for i, chunk in enumerate(chunks, start=1):
        title = chunk.get("title", "")[:80]
        section = chunk.get("section", "")
        text = chunk.get("text", "")
        if len(text) > _MAX_CHUNK_CHARS:
            text = text[:_MAX_CHUNK_CHARS] + "…"
        header = f"### م {i}: {title}"
        if section:
            header += f" — {section}"
        chunks_text += f"{header}\n{text}\n\n"

    system = _SYNTHESIS_SYSTEM_PROMPT.format(chunks=chunks_text.strip())

    client = OpenAI(api_key=api_key)
    try:
        stream = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": query},
            ],
            stream=True,
            temperature=0.25,
            max_tokens=4096,
        )
        for chunk_resp in stream:
            delta = chunk_resp.choices[0].delta
            if delta.content:
                yield f"data: {json.dumps({'token': delta.content})}\n\n"
        yield "data: [DONE]\n\n"
    except Exception:
        logger.exception("Synthesis stream error")
        yield f"data: {json.dumps({'error': 'حدث خطأ أثناء توليد الملخص. يرجى المحاولة مرة أخرى.'})}\n\n"
