"""
Hypothetical Document Embeddings (HyDE) for improved retrieval.

Instead of embedding the raw user query, HyDE generates a short hypothetical
academic paragraph that *would* answer the query, then embeds that paragraph.
The hypothesis sits in the same semantic space as actual document content,
dramatically improving recall for short Arabic queries against long academic text.

Reference: Gao et al. "Precise Zero-Shot Dense Retrieval without Relevance Labels"
           https://arxiv.org/abs/2212.10496
"""

from __future__ import annotations

import logging

from backend.services.openai_client import get_openai_client

logger = logging.getLogger(__name__)

_HYDE_PROMPT = """\
أنت باحث أكاديمي متخصص. اكتب فقرة أكاديمية واحدة (5-8 جمل) من ورقة بحثية عربية \
تُجيب مباشرةً على السؤال أو الموضوع التالي. اكتب بأسلوب أكاديمي رسمي كما لو كنت \
تقتطع من قسم النتائج أو المناقشة في دراسة علمية. لا تستخدم نقاطاً أو عناوين — \
فقرة نثرية متماسكة فقط.

الموضوع: {query}

الفقرة الأكاديمية:"""


def generate_hypothesis(query: str, *, timeout: float = 8.0) -> str:
    """Generate a hypothetical academic paragraph for the given query.

    Falls back to the original query on any error so search always proceeds.

    Args:
        query: The user's search query (Arabic or English).
        timeout: Maximum seconds to wait for the OpenAI call.

    Returns:
        The hypothesis text, or the original query if generation fails.
    """
    try:
        client = get_openai_client(timeout=timeout)
    except RuntimeError:
        logger.warning("OPENAI_API_KEY not set — skipping HyDE, using raw query")
        return query

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "user", "content": _HYDE_PROMPT.format(query=query)},
            ],
            temperature=0.7,
            max_tokens=150,  # shorter = faster; enough for dense one-paragraph hypothesis
        )
        hypothesis = response.choices[0].message.content or ""
        hypothesis = hypothesis.strip()
        if hypothesis:
            logger.debug("HyDE hypothesis (%d chars) for query: %s", len(hypothesis), query[:60])
            return hypothesis
    except Exception:
        logger.warning("HyDE generation failed, falling back to raw query", exc_info=True)

    return query
