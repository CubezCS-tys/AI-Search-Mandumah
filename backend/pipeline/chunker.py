"""
Structure-aware chunking for Arabic academic documents.

Takes the JSON `content` field from Azure Document Intelligence output
and produces chunks optimized for RAG retrieval:
- Respects paragraph/section boundaries
- Strips page numbers and boilerplate
- Prepends document title + section header to each chunk
- Skips reference/bibliography sections
- Target ~400 tokens (~1600 Arabic chars), with 10% overlap
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Arabic char ≈ 4 chars/token on average for multilingual models.
# Target 400 tokens → ~1600 chars.  Min 100 tokens → 400 chars.
# ---------------------------------------------------------------------------
DEFAULT_TARGET_CHARS = 1600
DEFAULT_MIN_CHARS = 400
DEFAULT_MAX_CHARS = 2400
DEFAULT_OVERLAP_CHARS = 160  # ~10% of target

# Regex patterns
_PAGE_NUM_RE = re.compile(r"^[٠-٩\d]{1,4}$")

_REFERENCE_HEADERS = re.compile(
    r"^(المراجع|المصادر|قائمة المراجع|قائمة المصادر|المراجع والمصادر"
    r"|References|Bibliography|Works Cited|قائمة المراجع والمصادر"
    r"|المصادر والمراجع)\s*:?\s*$",
    re.IGNORECASE,
)

_SECTION_HEADER_RE = re.compile(
    r"^(المقدمة|الخاتمة|المستخلص|Abstract|الملخص|ملخص البحث"
    r"|مشكلة البحث|أهداف البحث|أهمية البحث|فرضيات البحث"
    r"|منهج البحث|منهجية البحث|حدود البحث"
    r"|النتائج|نتائج البحث|المناقشة|التوصيات"
    r"|الإطار النظري|الدراسات السابقة|الفصل\s+.+"
    r"|المبحث\s+.+|Introduction|Methodology|Results"
    r"|Discussion|Conclusion)\s*:?\s*$",
    re.IGNORECASE,
)

# Broader pattern: short line ending with colon, or matching known patterns
_HEADING_LIKE_RE = re.compile(
    r"^.{5,60}:\s*$"  # Short line ending with colon
)

# Sentence boundary for Arabic + Latin
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?؟。])\s+")

# Boilerplate patterns to remove
_BOILERPLATE_RE = re.compile(
    r"^(مجلة\s.{5,80}|المجلة\s.{5,80}|العدد\s.{3,30}|المجلد\s.{3,30}"
    r"|ISSN\s*:?\s*[\d\-]+|DOI\s*:?\s*\S+"
    r"|جامعة\s.{3,50}\s*[-–]\s*كلية"
    r"|Volume\s*\d|Issue\s*\d|Vol\.\s*\d"
    r"|(يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)\s*[٠-٩\d]{4}\s*م?"
    r"|(January|February|March|April|May|June|July|August|September|October|November|December)\s*\d{4})$",
    re.IGNORECASE,
)


@dataclass
class Chunk:
    """A single chunk ready for embedding."""
    chunk_id: str           # e.g. "0005-075-001-002_chunk_003"
    doc_id: str             # e.g. "0005-075-001-002"
    text: str               # The raw chunk text (without prepended context)
    embed_text: str         # Text to embed: title + section + chunk text
    section: str            # Current section header
    char_len: int           # Length of text
    chunk_index: int        # 0-based index within document
    page_start: int | None  # Approximate starting page (if determinable)
    metadata: dict = field(default_factory=dict)


@dataclass
class ChunkingResult:
    """Result of chunking a single document."""
    doc_id: str
    title: str
    chunks: list[Chunk]
    total_chars: int
    skipped_reference_chars: int


def _is_page_number(line: str) -> bool:
    return bool(_PAGE_NUM_RE.match(line.strip()))


def _is_reference_header(line: str) -> bool:
    return bool(_REFERENCE_HEADERS.match(line.strip()))


def _is_section_header(line: str) -> bool:
    stripped = line.strip()
    if _SECTION_HEADER_RE.match(stripped):
        return True
    if _HEADING_LIKE_RE.match(stripped) and len(stripped) < 60:
        return True
    return False


def _is_boilerplate(line: str) -> bool:
    stripped = line.strip()
    if len(stripped) < 5:
        return True
    if _BOILERPLATE_RE.match(stripped):
        return True
    return False


_AUTHOR_LINE_RE = re.compile(
    r"(^|\s)(?:أ\s*\.?\s*د|د\s*\.?|دكتور(?:ة)?\.?|أ\s*\.?\s*م|م\s*\.?\s*م|"
    r"الدكتور|الدكتورة|الأستاذ|الاستاذ|الأستاذة|الاستاذة|"
    r"Prof\.?|Dr\.?|By|بقلم|إعداد|اعداد)(\s|$)|"
    r"@|جامعة\s.+كلية|كلية\s.+قسم|قسم\s.+كلية|"
    r"\.edu\.|\.ac\.|\.com$|\.org$",
    re.IGNORECASE,
)


def _is_author_line(line: str) -> bool:
    return bool(_AUTHOR_LINE_RE.search(line))


def _extract_title(lines: list[str]) -> str:
    """Extract the document title from the first few meaningful lines."""
    candidates: list[tuple[float, int, str]] = []
    for idx, line in enumerate(lines[:20]):
        stripped = line.strip()
        if not stripped:
            continue
        if _is_page_number(stripped):
            continue
        if _is_boilerplate(stripped):
            continue
        if _is_author_line(stripped):
            continue
        if _is_section_header(stripped):
            continue
        # Skip very short lines (dates, issue numbers)
        if len(stripped) < 10:
            continue
        score = 0.0
        if idx < 5:
            score += 1.2
        if 20 <= len(stripped) <= 140:
            score += 1.4
        elif 12 <= len(stripped) <= 180:
            score += 0.8
        if 4 <= len(stripped.split()) <= 18:
            score += 0.6
        if stripped.endswith((".", ":", "؛", "،")):
            score -= 0.4
        if any(ch.isdigit() for ch in stripped):
            score -= 0.25
        candidates.append((score, idx, stripped))

    if candidates:
        candidates.sort(key=lambda item: (-item[0], item[1]))
        return candidates[0][2]
    return ""


def _estimate_page(char_offset: int, page_boundaries: list[int]) -> int | None:
    """Estimate which page a character offset falls on."""
    if not page_boundaries:
        return None
    for i, boundary in enumerate(page_boundaries):
        if char_offset < boundary:
            return i + 1
    return len(page_boundaries)


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences, keeping the delimiter with the preceding sentence."""
    parts = _SENTENCE_SPLIT_RE.split(text)
    return [p.strip() for p in parts if p.strip()]


def chunk_document(
    content: str,
    doc_id: str,
    *,
    target_chars: int = DEFAULT_TARGET_CHARS,
    min_chars: int = DEFAULT_MIN_CHARS,
    max_chars: int = DEFAULT_MAX_CHARS,
    overlap_chars: int = DEFAULT_OVERLAP_CHARS,
) -> ChunkingResult:
    """
    Chunk a document's content field into retrieval-optimized chunks.

    Args:
        content: The `content` field from Azure Document Intelligence JSON.
        doc_id: The document identifier (e.g. "0005-075-001-002").
        target_chars: Target chunk size in characters.
        min_chars: Minimum chunk size - smaller chunks merge with previous.
        max_chars: Maximum chunk size - triggers a split.
        overlap_chars: Characters to overlap between consecutive chunks.

    Returns:
        ChunkingResult with list of Chunk objects.
    """
    lines = content.split("\n")
    title = _extract_title(lines)

    # --- Phase 1: Clean lines and identify structure ---
    cleaned: list[dict] = []  # {text, role, char_offset}
    current_section = ""
    in_references = False
    skipped_ref_chars = 0
    char_offset = 0

    for line in lines:
        stripped = line.strip()
        line_len = len(line) + 1  # +1 for newline

        if not stripped:
            char_offset += line_len
            continue

        if _is_page_number(stripped):
            char_offset += line_len
            continue

        if _is_reference_header(stripped):
            in_references = True
            char_offset += line_len
            continue

        if in_references:
            skipped_ref_chars += len(stripped)
            char_offset += line_len
            continue

        if _is_boilerplate(stripped):
            char_offset += line_len
            continue

        if _is_section_header(stripped):
            current_section = stripped.rstrip(":").strip()
            char_offset += line_len
            continue

        cleaned.append({
            "text": stripped,
            "section": current_section,
            "char_offset": char_offset,
        })
        char_offset += line_len

    # --- Phase 2: Build chunks with sentence-aware splitting ---
    chunks: list[Chunk] = []
    current_text = ""
    current_section = ""
    current_offset = 0
    chunk_index = 0

    def _flush_chunk(text: str, section: str, offset: int):
        nonlocal chunk_index
        if not text.strip():
            return
        embed_text = f"{title}\n{section}\n{text}" if section else f"{title}\n{text}"
        chunks.append(Chunk(
            chunk_id=f"{doc_id}_chunk_{chunk_index:03d}",
            doc_id=doc_id,
            text=text.strip(),
            embed_text=embed_text.strip(),
            section=section,
            char_len=len(text.strip()),
            chunk_index=chunk_index,
            page_start=None,
        ))
        chunk_index += 1

    for item in cleaned:
        text = item["text"]
        section = item["section"]

        # If section changed and we have accumulated text, flush
        if section != current_section and current_text:
            _flush_chunk(current_text, current_section, current_offset)
            # Overlap: keep tail of previous chunk
            if overlap_chars > 0 and len(current_text) > overlap_chars:
                current_text = current_text[-overlap_chars:]
            else:
                current_text = ""
            current_section = section
            current_offset = item["char_offset"]

        if not current_text:
            current_section = section
            current_offset = item["char_offset"]

        # Append the paragraph
        if current_text:
            current_text += " " + text
        else:
            current_text = text

        # Check if we've exceeded target
        while len(current_text) > max_chars:
            # Split at sentence boundary closest to target
            sentences = _split_sentences(current_text)
            if len(sentences) <= 1:
                # Can't split further - take as is
                _flush_chunk(current_text[:max_chars], current_section, current_offset)
                remainder = current_text[max_chars:]
                if overlap_chars > 0:
                    overlap_text = current_text[max_chars - overlap_chars:max_chars]
                    current_text = overlap_text + " " + remainder
                else:
                    current_text = remainder
                break

            # Accumulate sentences until we hit target
            built = ""
            split_point = 0
            for i, sent in enumerate(sentences):
                candidate = (built + " " + sent).strip() if built else sent
                if len(candidate) >= target_chars and built:
                    split_point = i
                    break
                built = candidate
                split_point = i + 1

            chunk_text = " ".join(sentences[:split_point]).strip()
            remainder_text = " ".join(sentences[split_point:]).strip()

            if chunk_text:
                _flush_chunk(chunk_text, current_section, current_offset)

            if overlap_chars > 0 and len(chunk_text) > overlap_chars:
                overlap_text = chunk_text[-overlap_chars:]
                current_text = (overlap_text + " " + remainder_text).strip()
            else:
                current_text = remainder_text

        # If still under target, keep accumulating

    # Flush remaining
    if current_text.strip():
        _flush_chunk(current_text, current_section, current_offset)

    # --- Phase 3: Post-process - merge small chunks with neighbors ---
    if len(chunks) > 1:
        merged_chunks: list[Chunk] = [chunks[0]]
        for c in chunks[1:]:
            prev = merged_chunks[-1]
            # Merge if current chunk is too small AND merging won't exceed max
            if c.char_len < min_chars and (prev.char_len + c.char_len) <= max_chars:
                merged_text = prev.text + " " + c.text
                section = prev.section or c.section
                embed_text = f"{title}\n{section}\n{merged_text}" if section else f"{title}\n{merged_text}"
                merged_chunks[-1] = Chunk(
                    chunk_id=prev.chunk_id,
                    doc_id=prev.doc_id,
                    text=merged_text,
                    embed_text=embed_text.strip(),
                    section=section,
                    char_len=len(merged_text),
                    chunk_index=prev.chunk_index,
                    page_start=prev.page_start,
                )
            # Also merge if previous chunk is too small
            elif prev.char_len < min_chars and (prev.char_len + c.char_len) <= max_chars:
                merged_text = prev.text + " " + c.text
                section = prev.section or c.section
                embed_text = f"{title}\n{section}\n{merged_text}" if section else f"{title}\n{merged_text}"
                merged_chunks[-1] = Chunk(
                    chunk_id=prev.chunk_id,
                    doc_id=prev.doc_id,
                    text=merged_text,
                    embed_text=embed_text.strip(),
                    section=section,
                    char_len=len(merged_text),
                    chunk_index=prev.chunk_index,
                    page_start=prev.page_start,
                )
            else:
                merged_chunks.append(c)

        # Re-index chunk IDs after merging
        for idx, c in enumerate(merged_chunks):
            merged_chunks[idx] = Chunk(
                chunk_id=f"{doc_id}_chunk_{idx:03d}",
                doc_id=c.doc_id,
                text=c.text,
                embed_text=c.embed_text,
                section=c.section,
                char_len=c.char_len,
                chunk_index=idx,
                page_start=c.page_start,
            )
        chunks = merged_chunks

    total_chars = sum(c.char_len for c in chunks)

    return ChunkingResult(
        doc_id=doc_id,
        title=title,
        chunks=chunks,
        total_chars=total_chars,
        skipped_reference_chars=skipped_ref_chars,
    )
