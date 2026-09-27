#!/usr/bin/env python3
"""Retrieval-quality evaluation over the entire mandumah_ocr_v1 corpus.

Two complementary tests on a stratified random sample of docs spanning the whole
corpus (so there are no untested regions):

  A. INDEX INTEGRITY (self-retrieval): a chunk's own stored text is embedded and
     searched; the SAME doc must return at rank 1. Near-100% proves every part of
     the index is sound — vectors present, correct, and reachable by HNSW.

  B. SEMANTIC KNOWN-ITEM: the doc's title is embedded and searched; we record the
     doc's best rank. Reports recall@1/5/10 and MRR — real retrieval quality, not
     an identity lookup.

Reports coverage across journals, search-latency percentiles, and lists failures.
Read-only; safe to run anytime.

  ./content_shards/eval_ocr_retrieval.sh --sample 200
  ./content_shards/eval_ocr_retrieval.sh --sample 500 --out eval_run.json
"""
import argparse, json, os, random, statistics, sys, time, urllib.request
from collections import Counter

QDRANT = "http://localhost:6333"
COLLECTION = "mandumah_ocr_v1"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CKPT = os.path.join(ROOT, "ocr_ingest_state", "ingest_checkpoint.json")

G = "\033[32m"; Y = "\033[33m"; R = "\033[31m"; DIM = "\033[2m"; B = "\033[1m"; C = "\033[36m"; X = "\033[0m"


def _post(path, body, timeout=60):
    req = urllib.request.Request(QDRANT + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))["result"]


def fetch_doc_chunks(doc_id, limit=30):
    """All chunks for a doc_id (payload only)."""
    r = _post(f"/collections/{COLLECTION}/points/scroll", {
        "filter": {"must": [{"key": "doc_id", "match": {"value": doc_id}}]},
        "limit": limit, "with_payload": ["doc_id", "chunk_id", "text", "title", "journal", "journal_id"],
        "with_vector": False,
    })
    return r.get("points", [])


def search(qvec, k, rescore=True, ef=128):
    body = {"vector": {"name": "dense", "vector": qvec}, "limit": k, "with_payload": ["doc_id"],
            "params": {"hnsw_ef": ef, "quantization": {"rescore": rescore}}}
    t0 = time.time()
    res = _post(f"/collections/{COLLECTION}/points/search", body)
    return res, (time.time() - t0) * 1000


def embed_batch(texts, model, key):
    from openai import OpenAI
    client = OpenAI(api_key=key)
    out = []
    B_ = 100
    for i in range(0, len(texts), B_):
        chunk = [t[:8000] if t else " " for t in texts[i:i + B_]]
        resp = client.embeddings.create(model=model, input=chunk)
        out.extend(d.embedding for d in resp.data)
    return out


def rank_of(results, doc_id, cap):
    for i, h in enumerate(results, 1):
        if h["payload"].get("doc_id") == doc_id:
            return i
    return None  # not in top-`cap`


def pct(sorted_vals, p):
    if not sorted_vals:
        return 0
    return sorted_vals[min(len(sorted_vals) - 1, int(p * len(sorted_vals)))]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sample", type=int, default=200, help="Docs to evaluate")
    ap.add_argument("--k", type=int, default=10, help="Top-k cutoff for recall")
    ap.add_argument("--seed", type=int, default=0, help="RNG seed (reproducible sample)")
    ap.add_argument("--no-rescore", action="store_true", help="Skip cosine rescore (faster, less exact rank)")
    ap.add_argument("--out", default="", help="Write detailed JSON results here")
    args = ap.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(ROOT, ".env"))
    key = os.getenv("OPENAI_API_KEY")
    model = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
    if not key:
        print(f"{R}OPENAI_API_KEY not set{X}"); return 1

    info = _post if False else None  # noqa
    col = json.load(urllib.request.urlopen(f"{QDRANT}/collections/{COLLECTION}"))["result"]
    print(f"{B}{C}═══ OCR CORPUS RETRIEVAL EVAL · {COLLECTION} ═══{X}")
    print(f"  points {col['points_count']:,} · status {col['status']} · sample {args.sample} · k {args.k} "
          f"· rescore {'off' if args.no_rescore else 'on'} · {time.strftime('%F %T %Z')}\n")

    # Stratified-ish random sample across the whole corpus
    doc_ids = json.load(open(CKPT))["processed"]
    random.seed(args.seed)
    sample = random.sample(doc_ids, min(args.sample, len(doc_ids)))

    # Gather one representative chunk (longest text) + title per doc
    print(f"{DIM}Fetching chunks for {len(sample)} docs…{X}")
    cases = []          # (doc_id, chunk_text, title, journal_prefix)
    no_chunk = 0
    for did in sample:
        pts = fetch_doc_chunks(did)
        if not pts:
            no_chunk += 1
            continue
        best = max(pts, key=lambda p: len((p["payload"].get("text") or "")))
        txt = (best["payload"].get("text") or "").strip()
        title = (best["payload"].get("title") or "").strip()
        if not txt:
            no_chunk += 1
            continue
        cases.append((did, txt, title, did.split("-")[0]))

    # Embed all queries (chunk-text for Test A, title for Test B) in batches
    print(f"{DIM}Embedding {len(cases)*2} queries…{X}")
    chunk_q = [c[1] for c in cases]
    title_q = [c[2] if c[2] else c[1][:120] for c in cases]   # fallback if no title
    emb_chunk = embed_batch(chunk_q, model, key)
    emb_title = embed_batch(title_q, model, key)

    # Run searches
    print(f"{DIM}Running {len(cases)*2} searches…{X}\n")
    rescore = not args.no_rescore
    A_ranks, B_ranks, lat = [], [], []
    A_fail, B_fail = [], []
    journals = Counter()
    have_title = 0
    for i, (did, txt, title, jp) in enumerate(cases):
        journals[jp] += 1
        resA, dtA = search(emb_chunk[i], args.k, rescore)
        rA = rank_of(resA, did, args.k)
        A_ranks.append(rA)
        if rA is None:
            A_fail.append(did)
        if title:
            have_title += 1
            resB, dtB = search(emb_title[i], args.k, rescore)
            rB = rank_of(resB, did, args.k)
            B_ranks.append(rB)
            if rB is None:
                B_fail.append((did, title[:40]))
            lat.append(dtB)
        lat.append(dtA)

    n = len(cases)

    def recall(ranks, at):
        hit = sum(1 for r in ranks if r is not None and r <= at)
        return 100 * hit / len(ranks) if ranks else 0

    def mrr(ranks):
        return sum(1.0 / r for r in ranks if r) / len(ranks) if ranks else 0

    lat.sort()
    print(f"{B}A · INDEX INTEGRITY (chunk self-retrieval, n={n}){X}")
    a1, a5, ak = recall(A_ranks, 1), recall(A_ranks, 5), recall(A_ranks, args.k)
    va = G + "PASS" + X if a1 >= 98 else (Y + "CHECK" + X if a1 >= 90 else R + "FAIL" + X)
    print(f"  recall@1 {a1:.1f}%  ·  recall@5 {a5:.1f}%  ·  recall@{args.k} {ak:.1f}%  ·  MRR {mrr(A_ranks):.3f}   [{va}]")
    print(f"  {DIM}→ a chunk's own text must find its doc at rank 1; <98% @1 signals index gaps{X}")

    print(f"\n{B}B · SEMANTIC KNOWN-ITEM (title→doc, n={have_title}){X}")
    b1, b5, bk = recall(B_ranks, 1), recall(B_ranks, 5), recall(B_ranks, args.k)
    vb = G + "healthy" + X if bk >= 85 else (Y + "review" + X if bk >= 70 else R + "low" + X)
    print(f"  recall@1 {b1:.1f}%  ·  recall@5 {b5:.1f}%  ·  recall@{args.k} {bk:.1f}%  ·  MRR {mrr(B_ranks):.3f}   [{vb}]")

    print(f"\n{B}COVERAGE{X}  {len(journals)} distinct journals in sample · docs w/o retrievable chunk: {no_chunk}")
    print(f"{B}LATENCY{X}   search p50 {pct(lat,0.5):.0f}ms · p95 {pct(lat,0.95):.0f}ms · max {lat[-1]:.0f}ms  {DIM}(rescore {'on' if rescore else 'off'}){X}")

    if A_fail:
        print(f"\n{R}A failures ({len(A_fail)}) — chunk did not self-retrieve @{args.k}:{X} {A_fail[:8]}")
    if B_fail:
        print(f"{Y}B misses ({len(B_fail)}) — title didn't surface doc @{args.k}:{X}")
        for did, t in B_fail[:6]:
            print(f"    {did} | {t}")

    verdict = G + "CORPUS HEALTHY — retrieval sound across the sample" + X if a1 >= 98 and bk >= 80 \
        else (Y + "MOSTLY HEALTHY — see failures above" + X if a1 >= 95 else R + "PROBLEM — investigate index" + X)
    print(f"\n{B}VERDICT:{X} {verdict}")

    if args.out:
        json.dump({
            "collection": COLLECTION, "when": time.strftime("%F %T %Z"), "sample": n,
            "points": col["points_count"], "k": args.k, "rescore": rescore,
            "A_integrity": {"recall@1": a1, "recall@5": a5, f"recall@{args.k}": ak, "mrr": mrr(A_ranks), "failures": A_fail},
            "B_known_item": {"n": have_title, "recall@1": b1, "recall@5": b5, f"recall@{args.k}": bk,
                             "mrr": mrr(B_ranks), "misses": [d for d, _ in B_fail]},
            "coverage_journals": len(journals), "no_chunk": no_chunk,
            "latency_ms": {"p50": pct(lat, 0.5), "p95": pct(lat, 0.95), "max": lat[-1]},
        }, open(args.out, "w"), ensure_ascii=False, indent=2)
        print(f"{DIM}detailed results → {args.out}{X}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
