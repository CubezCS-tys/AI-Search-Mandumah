"""
Citation-accuracy evaluation for corpus-wide chat.

Where ``ragas_eval.py`` scores *retrieval* quality, this harness scores how
faithfully the generated answer *cites* its retrieved evidence. The corpus chat
prompt requires every factual sentence to carry a «verbatim quote» copied from
an excerpt, and optionally a ``(المستند [N])`` source marker. This script runs
the live chat pipeline on a set of questions and measures:

  • quote_grounding   — fraction of «quotes» that actually appear (normalised
                        substring) in one of the retrieved source texts. This is
                        the core "are the citations real?" metric.
  • sentence_coverage — fraction of answer sentences that contain ≥1 «quote»
                        (a proxy for "no uncited claims").
  • docref_validity   — fraction of ``(المستند [N])`` markers whose N is a valid
                        excerpt index (1..top_k).
  • quotes_per_answer — average number of «quotes» per answer.

Usage:
    # Score the questions in eval/testset.csv (user_input column)
    python -m eval.citation_eval --testset eval/testset.csv --limit 20 --top-k 10

    # Score an inline list of questions
    python -m eval.citation_eval --question "ما هي التشوهات المعرفية؟"

Requires a live Qdrant collection and OPENAI_API_KEY, same as the running app.
Results are written to eval/citation_results.csv.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

EVAL_DIR = ROOT / "eval"
EVAL_DIR.mkdir(exist_ok=True)

DEFAULT_TESTSET_CSV = EVAL_DIR / "testset.csv"
DEFAULT_RESULTS_CSV = EVAL_DIR / "citation_results.csv"


# ── Arabic normalisation (mirrors the frontend's normalizeArabic) ──────────

_TASHKEEL_RE = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]")
_PUNCT_RE = re.compile(r"[.,،؛:؟!()\[\]{}«»\"'\-–—٪%/\\]")
_WS_RE = re.compile(r"\s+")


def normalize_arabic(s: str) -> str:
    """Strip tashkeel + punctuation and collapse whitespace for tolerant matching."""
    s = _TASHKEEL_RE.sub("", s)
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s)
    return s.strip().lower()


# ── Citation parsing ───────────────────────────────────────────────────────

_QUOTE_RE = re.compile(r"«([^»]+)»")
_DOCREF_RE = re.compile(r"\(\s*المستند\s*\[?\s*(\d+)\s*\]?\s*\)")
# Sentence splitter tolerant of Arabic + Latin terminators.
_SENT_RE = re.compile(r"[^.!?؟\n]+[.!?؟\n]?")


def extract_quotes(answer: str) -> list[str]:
    return [q.strip() for q in _QUOTE_RE.findall(answer) if q.strip()]


def extract_docrefs(answer: str) -> list[int]:
    return [int(n) for n in _DOCREF_RE.findall(answer)]


def split_sentences(answer: str) -> list[str]:
    return [s.strip() for s in _SENT_RE.findall(answer) if s.strip()]


# ── Run the live chat pipeline for one question ────────────────────────────


async def _answer_question(
    searcher, question: str, top_k: int
) -> tuple[str, list[dict]]:
    """Consume the corpus-chat SSE stream and return (answer_text, sources)."""
    from backend.services.corpus_chat import stream_corpus_chat

    answer_parts: list[str] = []
    sources: list[dict] = []

    async for line in stream_corpus_chat(
        question, [], searcher, retrieve_top_k=top_k
    ):
        if not line.startswith("data: "):
            continue
        payload = line[len("data: ") :].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if "token" in obj:
            answer_parts.append(obj["token"])
        elif "sources" in obj:
            sources = obj["sources"]
        elif "error" in obj:
            raise RuntimeError(obj["error"])

    return "".join(answer_parts), sources


# ── Scoring ────────────────────────────────────────────────────────────────


def score_answer(answer: str, sources: list[dict], top_k: int) -> dict:
    """Compute per-answer citation-accuracy metrics."""
    quotes = extract_quotes(answer)
    docrefs = extract_docrefs(answer)
    sentences = split_sentences(answer)

    # Pre-normalise the full source corpus text once for substring checks.
    norm_sources = [normalize_arabic(s.get("text", "")) for s in sources]

    grounded = 0
    for q in quotes:
        nq = normalize_arabic(q)
        if nq and any(nq in ns for ns in norm_sources):
            grounded += 1

    cited_sentences = sum(1 for s in sentences if "«" in s and "»" in s)
    valid_docrefs = sum(1 for n in docrefs if 1 <= n <= top_k)

    return {
        "n_quotes": len(quotes),
        "n_grounded": grounded,
        "quote_grounding": round(grounded / len(quotes), 4) if quotes else 0.0,
        "n_sentences": len(sentences),
        "n_cited_sentences": cited_sentences,
        "sentence_coverage": (
            round(cited_sentences / len(sentences), 4) if sentences else 0.0
        ),
        "n_docrefs": len(docrefs),
        "n_valid_docrefs": valid_docrefs,
        "docref_validity": (
            round(valid_docrefs / len(docrefs), 4) if docrefs else 1.0
        ),
        "answer_chars": len(answer),
    }


# ── Driver ─────────────────────────────────────────────────────────────────


def _load_questions(testset: Path, limit: int | None) -> list[str]:
    questions: list[str] = []
    with open(testset, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        col = "user_input" if "user_input" in (reader.fieldnames or []) else None
        if col is None:
            raise SystemExit(
                f"{testset} has no 'user_input' column "
                f"(columns: {reader.fieldnames})"
            )
        for row in reader:
            q = (row.get(col) or "").strip()
            if q:
                questions.append(q)
            if limit and len(questions) >= limit:
                break
    return questions


async def run(questions: list[str], top_k: int, out_csv: Path) -> None:
    from backend.services.search import Searcher

    searcher = Searcher(
        qdrant_url=os.getenv("QDRANT_URL", "http://localhost:6333"),
        collection_name=os.getenv("COLLECTION_NAME", "academic_articles_v2"),
    )

    rows: list[dict] = []
    for i, q in enumerate(questions, start=1):
        print(f"[{i}/{len(questions)}] {q[:70]}…")
        try:
            answer, sources = await _answer_question(searcher, q, top_k)
        except Exception as exc:  # noqa: BLE001 — report and continue
            print(f"  ! failed: {exc}")
            continue
        metrics = score_answer(answer, sources, top_k)
        metrics["question"] = q
        rows.append(metrics)
        print(
            f"  grounding={metrics['quote_grounding']:.2f} "
            f"coverage={metrics['sentence_coverage']:.2f} "
            f"quotes={metrics['n_quotes']} docref_ok={metrics['docref_validity']:.2f}"
        )

    if not rows:
        print("No answers scored.")
        return

    fieldnames = [
        "question",
        "quote_grounding",
        "sentence_coverage",
        "docref_validity",
        "n_quotes",
        "n_grounded",
        "n_sentences",
        "n_cited_sentences",
        "n_docrefs",
        "n_valid_docrefs",
        "answer_chars",
    ]
    with open(out_csv, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k, "") for k in fieldnames})

    n = len(rows)
    avg = lambda k: sum(r[k] for r in rows) / n  # noqa: E731
    print("\n── Aggregate citation accuracy ──")
    print(f"  answers scored        : {n}")
    print(f"  mean quote_grounding  : {avg('quote_grounding'):.3f}")
    print(f"  mean sentence_coverage: {avg('sentence_coverage'):.3f}")
    print(f"  mean docref_validity  : {avg('docref_validity'):.3f}")
    print(f"  mean quotes/answer    : {avg('n_quotes'):.1f}")
    print(f"\nSaved per-question results → {out_csv}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--testset",
        type=Path,
        default=DEFAULT_TESTSET_CSV,
        help="CSV with a 'user_input' column of questions.",
    )
    parser.add_argument(
        "--question",
        action="append",
        default=None,
        help="Score an inline question (repeatable); overrides --testset.",
    )
    parser.add_argument("--limit", type=int, default=20, help="Max questions.")
    parser.add_argument("--top-k", type=int, default=10, help="Chunks retrieved.")
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_RESULTS_CSV, help="Output CSV path."
    )
    args = parser.parse_args()

    if args.question:
        questions = args.question
    else:
        questions = _load_questions(args.testset, args.limit)

    if not questions:
        raise SystemExit("No questions to evaluate.")

    asyncio.run(run(questions, args.top_k, args.out))


if __name__ == "__main__":
    main()
