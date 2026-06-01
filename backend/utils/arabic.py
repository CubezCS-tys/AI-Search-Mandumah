"""
Shared Arabic text normalization and tokenization utilities.

Used by both the search service (query-time) and the embedder (ingest-time)
to ensure consistent text processing.
"""

from __future__ import annotations

import re

# ── Normalization ───────────────────────────────────────────────────────

ARABIC_NORMALIZE_TABLE = str.maketrans({
    "\u0623": "\u0627",  # أ → ا
    "\u0625": "\u0627",  # إ → ا
    "\u0622": "\u0627",  # آ → ا
    "\u0649": "\u064A",  # ى → ي
    "\u0624": "\u0648",  # ؤ → و
    "\u0626": "\u064A",  # ئ → ي
    "\u0629": "\u0647",  # ة → ه
    "_": " ",
})

ARABIC_DIACRITICS_RE = re.compile(r"[\u064B-\u065F\u0670\u06D6-\u06ED]")

# ── Tokenization ────────────────────────────────────────────────────────

TOKEN_RE = re.compile(r"[A-Za-z0-9\u0600-\u06FF]+")

STOPWORDS = frozenset({
    "في", "من", "على", "الى", "إلى", "عن", "مع", "بين", "هذا", "هذه", "ذلك", "تلك",
    "وقد", "كما", "الى", "أن", "إن", "او", "أو", "ثم", "بعد", "قبل", "لدى",
    "لها", "لهم", "عند", "حول", "ضمن", "كان", "كانت", "يكون", "تكون", "تم", "قد",
    "the", "and", "for", "with", "from", "into", "that", "this",
})


def normalize_arabic(text: str) -> str:
    """Normalize Arabic text: remove diacritics, unify letter forms."""
    text = ARABIC_DIACRITICS_RE.sub("", text)
    return text.translate(ARABIC_NORMALIZE_TABLE)


def tokenize_arabic(text: str, remove_stopwords: bool = True) -> list[str]:
    """Tokenize and normalize Arabic text, optionally removing stopwords."""
    normalized = normalize_arabic(text)
    tokens = [t.lower() for t in TOKEN_RE.findall(normalized)]
    if remove_stopwords:
        tokens = [t for t in tokens if t not in STOPWORDS]
    return tokens
