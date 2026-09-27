#!/usr/bin/env python3
"""Corpus-wide retrieval + document-availability evaluation across ALL federated
collections: legacy (documents_async), mandumah_v2, mandumah_ocr_v1.

Per collection, on a uniform random sample spanning the whole ID space:

  A. INDEX INTEGRITY — a chunk's own text is embedded & searched; the SAME doc
     must return at rank 1 (proves vectors present/correct/reachable everywhere).
  B. KNOWN-ITEM — the doc's title is searched; records recall@1/5/10, MRR.
  C. PDF CORRESPONDENCE — HEAD s3://<bucket>/<doc_id>/<doc_id>.pdf: does the
     original PDF backing each retrievable doc actually exist in S3?

Read-only. Handles each collection's schema (legacy = unnamed vector + `source`
filename + local originals; mandumah = named `dense` vector + `doc_id` + S3 PDFs).

  ./content_shards/eval_corpus.sh --sample 300
  ./content_shards/eval_corpus.sh --sample 500 --collections mandumah_ocr_v1,mandumah_v2 --out corpus_eval.json
"""
import argparse, json, os, random, time, urllib.request, uuid
from concurrent.futures import ThreadPoolExecutor

QDRANT = "http://localhost:6333"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S3_BUCKET = "mandumah-source-docs"
S3_REGION = "eu-north-1"

G="\033[32m"; Y="\033[33m"; R="\033[31m"; DIM="\033[2m"; B="\033[1m"; C="\033[36m"; X="\033[0m"

# Per-collection config: vector name (None=unnamed), the payload field that identifies
# a document, and how to derive a doc_id (for the S3 PDF key) from it.
COLLECTIONS = {
    "documents_async_01_10_2025": {"vec": None,    "id": "source", "sampler": "int",  "label": "legacy",      "s3_pdf": False},
    "mandumah_v2":                 {"vec": "dense", "id": "doc_id", "sampler": "uuid", "label": "mandumah_v2", "s3_pdf": True},
    "mandumah_ocr_v1":             {"vec": "dense", "id": "doc_id", "sampler": "uuid", "label": "mandumah_ocr","s3_pdf": True},
}


def _post(path, body, timeout=60):
    req = urllib.request.Request(QDRANT + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))["result"]


def _docid_from(idval):
    """S3 doc_id key from an id value (strip a legacy filename extension)."""
    for ext in (".doc", ".docx", ".pdf", ".txt"):
        if idval.endswith(ext):
            return idval[: -len(ext)]
    return idval


def sample_docs(col, cfg, n):
    """Collect n distinct docs (id + representative chunk text + title) via random offsets."""
    idf = cfg["id"]
    seen, out = set(), []
    attempts = 0
    while len(out) < n and attempts < n * 6 + 50:
        attempts += 1
        offset = str(uuid.uuid4()) if cfg["sampler"] == "uuid" else random.randint(0, 6 * 10**11)
        try:
            pts = _post(f"/collections/{col}/points/scroll",
                        {"offset": offset, "limit": 8, "with_payload": [idf, "text", "title"],
                         "with_vector": False}).get("points", [])
        except Exception:
            continue
        for p in pts:
            pl = p["payload"]; key = pl.get(idf)
            if not key or key in seen:
                continue
            txt = (pl.get("text") or "").strip()
            if not txt:
                continue
            seen.add(key)
            out.append({"id": key, "text": txt, "title": (pl.get("title") or "").strip()})
            if len(out) >= n:
                break
    return out


def search(col, cfg, qvec, k, rescore=True, ef=128):
    vec = {"name": cfg["vec"], "vector": qvec} if cfg["vec"] else qvec
    body = {"vector": vec, "limit": k, "with_payload": [cfg["id"]],
            "params": {"hnsw_ef": ef, "quantization": {"rescore": rescore}}}
    t0 = time.time()
    res = _post(f"/collections/{col}/points/search", body)
    return res, (time.time() - t0) * 1000


def rank_of(results, idval, idf):
    for i, h in enumerate(results, 1):
        if h["payload"].get(idf) == idval:
            return i
    return None


def embed_batch(texts, model, key):
    from openai import OpenAI
    client = OpenAI(api_key=key)
    out = []
    for i in range(0, len(texts), 100):
        chunk = [t[:8000] if t else " " for t in texts[i:i + 100]]
        out.extend(d.embedding for d in client.embeddings.create(model=model, input=chunk).data)
    return out


def pdf_head(s3, doc_id):
    try:
        h = s3.head_object(Bucket=S3_BUCKET, Key=f"{doc_id}/{doc_id}.pdf")
        return doc_id, h["ContentLength"]
    except Exception:
        return doc_id, None


def recall(ranks, at):
    r = [x for x in ranks]
    return 100 * sum(1 for x in r if x and x <= at) / len(r) if r else 0


def mrr(ranks):
    return sum(1.0 / x for x in ranks if x) / len(ranks) if ranks else 0


def pct(vals, p):
    v = sorted(vals)
    return v[min(len(v) - 1, int(p * len(v)))] if v else 0


def eval_collection(col, cfg, n, k, rescore, model, key, s3):
    docs = sample_docs(col, cfg, n)
    if not docs:
        return None
    idf = cfg["id"]
    emb_chunk = embed_batch([d["text"] for d in docs], model, key)
    titled = [d for d in docs if d["title"]]
    emb_title = embed_batch([d["title"] for d in titled], model, key) if titled else []

    A, B, lat, Afail = [], [], [], []
    for i, d in enumerate(docs):
        res, dt = search(col, cfg, emb_chunk[i], k, rescore); lat.append(dt)
        r = rank_of(res, d["id"], idf); A.append(r)
        if r is None:
            Afail.append(d["id"])
    for j, d in enumerate(titled):
        res, dt = search(col, cfg, emb_title[j], k, rescore); lat.append(dt)
        B.append(rank_of(res, d["id"], idf))

    # C. PDF correspondence — HEAD each doc's S3 PDF (threaded). Only meaningful for
    # S3-backed collections; legacy originals live in a different (.doc) store.
    if cfg.get("s3_pdf"):
        doc_ids = [_docid_from(d["id"]) for d in docs]
        with ThreadPoolExecutor(max_workers=16) as ex:
            heads = list(ex.map(lambda x: pdf_head(s3, x), doc_ids))
        present = [(d, sz) for d, sz in heads if sz is not None]
        missing = [d for d, sz in heads if sz is None]
    else:
        present, missing, doc_ids = [], [], []

    return {
        "n": len(docs), "titled": len(titled), "s3_pdf": cfg.get("s3_pdf", False),
        "A1": recall(A, 1), "A5": recall(A, 5), "Ak": recall(A, k), "Amrr": mrr(A), "Afail": Afail,
        "B1": recall(B, 1), "Bk": recall(B, k), "Bmrr": mrr(B),
        "pdf_present": len(present), "pdf_missing": len(missing), "pdf_missing_ids": missing[:10],
        "pdf_pct": (100 * len(present) / len(doc_ids)) if doc_ids else None,
        "lat_p50": pct(lat, 0.5), "lat_p95": pct(lat, 0.95),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sample", type=int, default=300, help="Docs per collection")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--collections", default=",".join(COLLECTIONS), help="Comma-separated collection names")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-rescore", action="store_true")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(ROOT, ".env"))
    key = os.getenv("OPENAI_API_KEY"); model = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
    if not key:
        print(f"{R}OPENAI_API_KEY not set{X}"); return 1
    import boto3
    s3 = boto3.client("s3", region_name=S3_REGION)
    random.seed(args.seed)
    rescore = not args.no_rescore

    print(f"{B}{C}══════ CORPUS-WIDE RETRIEVAL + PDF EVAL ══════{X}")
    print(f"  {args.sample}/collection · k {args.k} · rescore {'off' if args.no_rescore else 'on'} · {time.strftime('%F %T %Z')}\n")

    cols = [c.strip() for c in args.collections.split(",") if c.strip()]
    results = {}
    for col in cols:
        if col not in COLLECTIONS:
            print(f"{Y}skip unknown collection {col}{X}"); continue
        cfg = COLLECTIONS[col]
        print(f"{DIM}evaluating {cfg['label']} ({col})…{X}")
        r = eval_collection(col, cfg, args.sample, args.k, rescore, model, key, s3)
        results[col] = r
        if not r:
            print(f"  {R}no sample{X}"); continue
        va = G+"PASS"+X if r["A1"] >= 98 else (Y+"CHECK"+X if r["A1"] >= 90 else R+"FAIL"+X)
        print(f"  {B}A integrity{X}  @1 {r['A1']:.1f}% · @{args.k} {r['Ak']:.1f}% · MRR {r['Amrr']:.3f}   [{va}]")
        print(f"  {B}B known-item{X} @1 {r['B1']:.1f}% · @{args.k} {r['Bk']:.1f}% · MRR {r['Bmrr']:.3f}   (n={r['titled']})")
        if r["pdf_pct"] is None:
            print(f"  {B}C pdf-in-S3{X}  {DIM}N/A — legacy originals are .doc in a separate store, not mandumah-source-docs{X}")
        else:
            pv = G if r["pdf_pct"] >= 99 else (Y if r["pdf_pct"] >= 90 else R)
            print(f"  {B}C pdf-in-S3{X}  {pv}{r['pdf_pct']:.1f}%{X} present ({r['pdf_present']}/{r['n']}) · missing {r['pdf_missing']}")
            if r["pdf_missing_ids"]:
                print(f"     {DIM}missing PDFs e.g.: {r['pdf_missing_ids'][:5]}{X}")
        print(f"  {B}latency{X}     p50 {r['lat_p50']:.0f}ms · p95 {r['lat_p95']:.0f}ms\n")

    # overall verdict (PDF gate only over S3-backed collections)
    ok = all(r and r["A1"] >= 97 for r in results.values())
    pdf_ok = all(r["pdf_pct"] >= 95 for r in results.values() if r and r["pdf_pct"] is not None)
    verdict = (G+"ALL COLLECTIONS HEALTHY — retrieval sound + PDFs present"+X) if ok and pdf_ok \
        else (Y+"REVIEW — see per-collection flags above"+X)
    print(f"{B}OVERALL:{X} {verdict}")

    if args.out:
        json.dump({"when": time.strftime("%F %T %Z"), "sample_per_collection": args.sample,
                   "k": args.k, "rescore": rescore, "collections": results},
                  open(args.out, "w"), ensure_ascii=False, indent=2)
        print(f"{DIM}detailed results → {args.out}{X}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
