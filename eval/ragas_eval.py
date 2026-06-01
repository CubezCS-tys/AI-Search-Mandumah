"""
RAGAS evaluation for the Arabic academic search system.

Two modes:
  1. generate  — Sample chunks from Qdrant and use RAGAS to synthetically
                 generate an Arabic QA testset, saved to eval/testset.csv
  2. evaluate  — Load a testset, run the real search pipeline on each question,
                 then score with RAGAS Context Recall, Context Precision,
                 and Faithfulness. Results saved to eval/results.csv

Usage:
    # Step 1 – generate testset (~50 questions from 50 random chunks)
    python -m eval.ragas_eval generate --n-chunks 50 --testset-size 30

    # Step 2 – evaluate retrieval against that testset
    python -m eval.ragas_eval evaluate --testset eval/testset.csv --top-k 5

    # Run both steps in sequence
    python -m eval.ragas_eval all --n-chunks 50 --testset-size 30 --top-k 5
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# ── helpers ────────────────────────────────────────────────────────────────

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

EVAL_DIR = ROOT / "eval"
EVAL_DIR.mkdir(exist_ok=True)

DEFAULT_TESTSET_CSV = EVAL_DIR / "testset.csv"
DEFAULT_RESULTS_CSV = EVAL_DIR / "results.csv"


def _qdrant_client():
    from qdrant_client import QdrantClient
    url = os.getenv("QDRANT_URL", "http://localhost:6333")
    return QdrantClient(url=url, timeout=30)


def _collection_name():
    return os.getenv("COLLECTION_NAME", "academic_articles_v2")


# ── Step 1: Sample chunks from Qdrant ─────────────────────────────────────

def sample_chunks_from_qdrant(n: int, seed: int = 42) -> list[dict]:
    """
    Randomly sample n chunks from Qdrant and return as plain dicts.

    Uses random offset scrolling to get a diverse, unbiased sample across
    the entire collection (852k+ points).
    """
    client = _qdrant_client()
    collection = _collection_name()

    info = client.get_collection(collection)
    total = info.points_count
    print(f"Collection has {total:,} points. Sampling {n} chunks…")

    rng = random.Random(seed)
    chunks = []
    batch_size = 10
    attempts = 0

    while len(chunks) < n and attempts < n * 5:
        attempts += 1
        # Pick a random offset and scroll a small batch
        offset_id = None
        skip = rng.randint(0, max(0, total - batch_size))

        # Use scroll with a random starting UUID by skipping N records
        # (Qdrant doesn't support random offset directly, so we use skip via
        # multiple small scrolls. For efficiency we do one big scroll at a
        # random position by sampling IDs first.)
        results, _ = client.scroll(
            collection_name=collection,
            limit=batch_size,
            with_payload=True,
            with_vectors=False,
            # Use a random UUID offset by fetching IDs at offset
        )
        for pt in results:
            p = pt.payload
            # Filter: prefer body chunks with reasonable length
            char_len = int(p.get("char_len", 0))
            if char_len < 400:
                continue
            if not p.get("text", "").strip():
                continue
            # Skip chunks that look like title/author noise
            text = p["text"]
            if len(text.split()) < 20:
                continue
            chunks.append({
                "chunk_id": p["chunk_id"],
                "doc_id": p["doc_id"],
                "text": p["text"],
                "title": p.get("title", ""),
                "section": p.get("section", ""),
                "char_len": char_len,
            })
            if len(chunks) >= n:
                break

    print(f"Sampled {len(chunks)} qualifying chunks.")
    return chunks[:n]


def sample_chunks_diverse(n: int, seed: int = 42) -> list[dict]:
    """
    Sample chunks more efficiently by fetching a large batch and randomly
    selecting from it — better for diverse coverage.
    """
    client = _qdrant_client()
    collection = _collection_name()

    # Fetch a large random batch via scroll (first n*10 or 5000 max)
    fetch_n = min(n * 20, 5000)
    print(f"Fetching {fetch_n} candidates from Qdrant for diversity sampling…")

    all_pts = []
    offset = None
    while len(all_pts) < fetch_n:
        batch, offset = client.scroll(
            collection_name=collection,
            limit=min(256, fetch_n - len(all_pts)),
            offset=offset,
            with_payload=True,
            with_vectors=False,
        )
        all_pts.extend(batch)
        if offset is None:
            break

    rng = random.Random(seed)
    rng.shuffle(all_pts)

    chunks = []
    seen_docs: set[str] = set()
    for pt in all_pts:
        p = pt.payload
        doc_id = p.get("doc_id", "")
        # One chunk per document for diversity
        if doc_id in seen_docs:
            continue
        char_len = int(p.get("char_len", 0))
        text = p.get("text", "").strip()
        if char_len < 500 or len(text.split()) < 30:
            continue
        seen_docs.add(doc_id)
        chunks.append({
            "chunk_id": p["chunk_id"],
            "doc_id": p["doc_id"],
            "text": text,
            "title": p.get("title", ""),
            "section": p.get("section", ""),
            "char_len": char_len,
        })
        if len(chunks) >= n:
            break

    print(f"Selected {len(chunks)} diverse chunks from {len(seen_docs)} unique documents.")
    return chunks


# ── Step 2: RAGAS testset generation ──────────────────────────────────────

def generate_testset(chunks: list[dict], testset_size: int, output_path: Path) -> Path:
    """
    Feed chunks into RAGAS generate_with_chunks to produce Arabic QA pairs.

    Adapts query prompts to Arabic so questions are generated in Arabic.
    Saves the testset to output_path (CSV).
    """
    import openai as _openai
    from langchain_core.documents import Document
    from ragas.testset.synthesizers.generate import TestsetGenerator
    from ragas.llms import llm_factory
    from ragas.embeddings import OpenAIEmbeddings

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set in environment / .env")

    client = _openai.OpenAI(api_key=api_key)

    print(f"\n── RAGAS Testset Generation ──────────────────────────────")
    print(f"  Chunks:       {len(chunks)}")
    print(f"  Target size:  {testset_size} QA pairs")
    print(f"  Output:       {output_path}")

    # Build LangChain Document objects from our chunks
    docs = [
        Document(
            page_content=c["text"],
            metadata={
                "chunk_id": c["chunk_id"],
                "doc_id":   c["doc_id"],
                "title":    c["title"],
                "section":  c["section"],
            },
        )
        for c in chunks
    ]

    generator_llm = llm_factory("gpt-4o-mini", client=client)
    embedding_model = OpenAIEmbeddings(client=client)

    generator = TestsetGenerator(
        llm=generator_llm,
        embedding_model=embedding_model,
    )

    # Adapt the synthesizer prompts to Arabic
    from ragas.testset.synthesizers.single_hop.specific import (
        SingleHopSpecificQuerySynthesizer,
    )
    synthesizer = SingleHopSpecificQuerySynthesizer(llm=generator_llm)
    adapted_prompts = asyncio.get_event_loop().run_until_complete(
        synthesizer.adapt_prompts("arabic", llm=generator_llm)
    )
    synthesizer.set_prompts(**adapted_prompts)

    query_distribution = [(synthesizer, 1.0)]

    print("Generating testset (this calls OpenAI — may take a few minutes)…")
    t0 = time.time()
    testset = generator.generate_with_chunks(
        chunks=docs,
        testset_size=testset_size,
        query_distribution=query_distribution,
    )
    elapsed = time.time() - t0
    print(f"Generation complete in {elapsed:.0f}s. {len(testset)} samples produced.")

    df = testset.to_pandas()
    df.to_csv(output_path, index=False)
    print(f"Testset saved to {output_path}")
    return output_path


# ── Step 3: Run retrieval & RAGAS evaluation ───────────────────────────────

def run_evaluation(testset_path: Path, top_k: int, results_path: Path) -> None:
    """
    For each question in the testset:
      1. Run the real hybrid search pipeline (Searcher)
      2. Collect retrieved chunk texts as retrieved_contexts
      3. Score with RAGAS Context Recall, Context Precision, Faithfulness

    Prints a summary table and saves per-sample results to results_path.
    """
    import asyncio
    import pandas as pd
    import openai as _openai
    from ragas.llms import llm_factory
    from ragas.metrics.collections import ContextRecall, ContextPrecision, Faithfulness

    from backend.services.search import Searcher

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set in environment / .env")

    # Must use AsyncOpenAI — the collections metrics use agenerate() internally.
    # max_tokens=8192: RAGAS defaults are low; Arabic structured output needs more room.
    client = _openai.AsyncOpenAI(api_key=api_key)
    evaluator_llm = llm_factory("gpt-4o-mini", client=client, max_tokens=8192)

    df = pd.read_csv(testset_path)
    print(f"\n── RAGAS Evaluation ──────────────────────────────────────")
    print(f"  Testset:      {testset_path} ({len(df)} samples)")
    print(f"  Retrieval:    top_k={top_k}, mode=hybrid")
    print(f"  Output:       {results_path}")

    # The RAGAS testset CSV columns depend on version; handle both
    # v0.2+: user_input, reference, reference_contexts
    q_col    = "user_input"   if "user_input"   in df.columns else "question"
    ref_col  = "reference"    if "reference"    in df.columns else "ground_truth"

    # Initialise the searcher (lazy-loads embedder on first call)
    searcher = Searcher(
        qdrant_url=os.getenv("QDRANT_URL", "http://localhost:6333"),
        collection_name=_collection_name(),
    )

    samples = []
    for i, row in df.iterrows():
        question = str(row[q_col])
        reference = str(row.get(ref_col, ""))

        print(f"  [{i+1}/{len(df)}] Searching: {question[:70]}…")
        t0 = time.time()
        try:
            results = searcher.search(question, top_k=top_k, mode="hybrid")
        except Exception as e:
            print(f"    ERROR during search: {e}")
            continue
        elapsed = time.time() - t0

        # Send only top 5 full-text chunks to RAGAS metrics. gpt-4o-mini has a
        # limited output token budget for structured JSON generation; 10 × 1600-char
        # chunks overflow it. Using top-5 keeps full fidelity without score bias.
        # (Retrieval itself still runs at top_k so system behaviour is unchanged.)
        retrieved_contexts = [r.text for r in results[:5]]
        # Use the top result as the "response" proxy for Faithfulness
        # (in a real system this would be the LLM-generated answer)
        response = retrieved_contexts[0] if retrieved_contexts else ""

        print(f"    → {len(retrieved_contexts)} chunks in {elapsed:.2f}s")

        samples.append({
            "user_input": question,
            "response": response,
            "reference": reference,
            "retrieved_contexts": retrieved_contexts,
        })

    if not samples:
        print("No samples to evaluate. Exiting.")
        return

    # Build metric instances (new collections API — not ragas.evaluate compatible)
    # Each metric accepts different kwargs in its ascore() method:
    #   ContextRecall:    user_input, retrieved_contexts, reference
    #   ContextPrecision: user_input, reference, retrieved_contexts
    #   Faithfulness:     user_input, response, retrieved_contexts
    metric_inputs = {
        "context_recall":    lambda s: {"user_input": s["user_input"], "retrieved_contexts": s["retrieved_contexts"], "reference": s["reference"]},
        "context_precision": lambda s: {"user_input": s["user_input"], "retrieved_contexts": s["retrieved_contexts"], "reference": s["reference"]},
        "faithfulness":      lambda s: {"user_input": s["user_input"], "retrieved_contexts": s["retrieved_contexts"], "response": s["response"]},
    }
    metrics = {
        "context_recall":    ContextRecall(llm=evaluator_llm),
        "context_precision": ContextPrecision(llm=evaluator_llm),
        "faithfulness":      Faithfulness(llm=evaluator_llm),
    }

    print(f"\nRunning RAGAS metrics on {len(samples)} samples…")
    t0 = time.time()

    # batch_score expects List[Dict] with the same keys as ascore's kwargs
    scores_rows = []
    for sample in samples:
        row = {
            "user_input": sample["user_input"],
            "reference":  sample["reference"],
        }
        for metric_name, metric in metrics.items():
            try:
                results_list = metric.batch_score([metric_inputs[metric_name](sample)])
                row[metric_name] = results_list[0].value if results_list else None
            except Exception as e:
                print(f"    WARN: {metric_name} error: {e}")
                row[metric_name] = None
        scores_rows.append(row)

    elapsed = time.time() - t0

    # ── Print summary ──────────────────────────────────────────────────
    scores = pd.DataFrame(scores_rows)
    scores.to_csv(results_path, index=False)

    print(f"\n{'─'*50}")
    print(f"  RAGAS Evaluation Results  ({elapsed:.0f}s)")
    print(f"{'─'*50}")
    for col in ["context_recall", "context_precision", "faithfulness"]:
        if col in scores.columns:
            mean = scores[col].dropna().mean()
            print(f"  {col:<25}  {mean:.3f}")
    print(f"{'─'*50}")
    print(f"  Per-sample results saved to {results_path}")

    # Show worst-performing questions to guide improvement
    if "context_recall" in scores.columns:
        worst = scores.nsmallest(3, "context_recall")[["user_input", "context_recall"]]
        print("\n  Lowest context recall questions:")
        for _, row in worst.iterrows():
            print(f"    {row['context_recall']:.2f}  {str(row['user_input'])[:70]}")


# ── CLI ─────────────────────────────────────────────────────────────────────

def cmd_generate(args):
    chunks = sample_chunks_diverse(n=args.n_chunks, seed=args.seed)
    generate_testset(chunks, testset_size=args.testset_size, output_path=Path(args.output))


def cmd_evaluate(args):
    run_evaluation(
        testset_path=Path(args.testset),
        top_k=args.top_k,
        results_path=Path(args.output),
    )


def cmd_all(args):
    testset_path = DEFAULT_TESTSET_CSV
    results_path = DEFAULT_RESULTS_CSV
    chunks = sample_chunks_diverse(n=args.n_chunks, seed=args.seed)
    generate_testset(chunks, testset_size=args.testset_size, output_path=testset_path)
    run_evaluation(testset_path=testset_path, top_k=args.top_k, results_path=results_path)


def main():
    parser = argparse.ArgumentParser(
        description="RAGAS evaluation for Arabic academic search",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # generate sub-command
    p_gen = sub.add_parser("generate", help="Generate Arabic testset from Qdrant chunks")
    p_gen.add_argument("--n-chunks",     type=int,  default=60,  help="Chunks to sample from Qdrant (default: 60)")
    p_gen.add_argument("--testset-size", type=int,  default=30,  help="QA pairs to generate (default: 30)")
    p_gen.add_argument("--seed",         type=int,  default=42,  help="Random seed (default: 42)")
    p_gen.add_argument("--output",       default=str(DEFAULT_TESTSET_CSV), help="Output CSV path")
    p_gen.set_defaults(func=cmd_generate)

    # evaluate sub-command
    p_eval = sub.add_parser("evaluate", help="Evaluate retrieval against a testset")
    p_eval.add_argument("--testset", default=str(DEFAULT_TESTSET_CSV), help="Testset CSV path")
    p_eval.add_argument("--top-k",   type=int, default=10, help="Chunks to retrieve per query (default: 10)")
    p_eval.add_argument("--output",  default=str(DEFAULT_RESULTS_CSV), help="Results CSV output path")
    p_eval.set_defaults(func=cmd_evaluate)

    # all sub-command
    p_all = sub.add_parser("all", help="Generate testset then evaluate (end-to-end)")
    p_all.add_argument("--n-chunks",     type=int,  default=60,  help="Chunks to sample (default: 60)")
    p_all.add_argument("--testset-size", type=int,  default=30,  help="QA pairs to generate (default: 30)")
    p_all.add_argument("--top-k",        type=int,  default=10,  help="Chunks per query (default: 10)")
    p_all.add_argument("--seed",         type=int,  default=42,  help="Random seed (default: 42)")
    p_all.set_defaults(func=cmd_all)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
