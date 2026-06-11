"""
Performance measurement script for the MCP server.

Run manually from the repo root (with venv activated and Qdrant running):
    python backend/tests/perf_mcp.py

Records:
- p50 / p95 latency of search_articles over 20 sequential calls
- 10 concurrent search_articles calls + /api/health mid-burst check
- get_article with max_chars=40000 on the first available doc
"""

from __future__ import annotations

import asyncio
import os
import statistics
import time
from typing import Any

# Ensure project root is on path
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

QUERY = "التعلم الإلكتروني في التعليم العالي"


def _check_env():
    missing = []
    if not os.getenv("QDRANT_URL"):
        missing.append("QDRANT_URL")
    if not os.getenv("OPENAI_API_KEY"):
        missing.append("OPENAI_API_KEY")
    if missing:
        print(f"[SKIP] Missing env vars: {', '.join(missing)}")
        sys.exit(0)


async def _search_one() -> float:
    """Call search_articles and return elapsed seconds."""
    from backend import mcp_server
    t0 = time.perf_counter()
    await mcp_server.search_articles(query=QUERY, top_k=10)
    return time.perf_counter() - t0


async def bench_sequential(n: int = 20):
    """p50 / p95 over n sequential calls."""
    print(f"\n=== Sequential search_articles (n={n}) ===")
    latencies = []
    for i in range(n):
        elapsed = await _search_one()
        latencies.append(elapsed)
        print(f"  [{i+1:02d}] {elapsed*1000:.0f} ms")

    latencies.sort()
    p50 = statistics.median(latencies) * 1000
    p95 = latencies[int(len(latencies) * 0.95)] * 1000
    print(f"\n  p50={p50:.0f}ms  p95={p95:.0f}ms")

    if p95 > 2500:
        print(f"  [WARN] p95 {p95:.0f}ms exceeds 2500ms target")
    else:
        print(f"  [OK]  p95 within 2500ms target")

    return p50, p95


async def bench_concurrent(n: int = 10):
    """10 concurrent calls + health mid-burst."""
    print(f"\n=== Concurrent search_articles (n={n}) ===")

    import httpx

    api_base = os.getenv("API_BASE_URL", "http://localhost:8000")

    async def search_task(i: int) -> float:
        t0 = time.perf_counter()
        await _search_one()
        return time.perf_counter() - t0

    async def health_task() -> float:
        """Hit /api/health mid-burst; must respond < 500ms."""
        await asyncio.sleep(0.1)  # give burst a head start
        async with httpx.AsyncClient() as client:
            t0 = time.perf_counter()
            resp = await client.get(f"{api_base}/api/health", timeout=5)
            elapsed = (time.perf_counter() - t0) * 1000
        return elapsed

    search_coros = [search_task(i) for i in range(n)]
    health_coro = health_task()

    results = await asyncio.gather(*search_coros, health_coro, return_exceptions=True)

    search_latencies = [r for r in results[:-1] if isinstance(r, float)]
    health_ms = results[-1] if isinstance(results[-1], float) else None

    errors = [r for r in results if isinstance(r, Exception)]
    if errors:
        print(f"  [FAIL] {len(errors)} errors: {errors[:3]}")
    else:
        print(f"  All {len(search_latencies)} search calls completed without error")

    if health_ms is not None:
        flag = "[OK]" if health_ms < 500 else "[WARN]"
        print(f"  {flag} /api/health mid-burst: {health_ms:.0f}ms")
    else:
        print(f"  [SKIP] /api/health check failed (server not reachable at {api_base})")

    if search_latencies:
        p50 = statistics.median(sorted(search_latencies)) * 1000
        print(f"  Concurrent p50: {p50:.0f}ms")

    return search_latencies, health_ms


async def bench_get_article():
    """get_article with max_chars=40000 on the first available doc."""
    print("\n=== get_article (max_chars=40000) ===")

    from backend import mcp_server

    # Get a doc_id first
    search_res = await mcp_server.search_articles(query=QUERY, top_k=1)
    if not search_res["results"]:
        print("  [SKIP] No search results — cannot test get_article")
        return

    doc_id = search_res["results"][0]["doc_id"]
    print(f"  doc_id: {doc_id}")

    t0 = time.perf_counter()
    article = await mcp_server.get_article(doc_id=doc_id, max_chars=40000)
    elapsed_ms = (time.perf_counter() - t0) * 1000

    total_chars = article.get("total_chars", 0)
    response_chars = len(article.get("text", ""))
    print(f"  total_chars: {total_chars:,}")
    print(f"  response_chars: {response_chars:,}")
    print(f"  latency: {elapsed_ms:.0f}ms")

    return elapsed_ms, total_chars


async def main():
    _check_env()

    print("Mandumah MCP Performance Benchmark")
    print("=" * 40)

    p50, p95 = await bench_sequential()
    await bench_concurrent()
    await bench_get_article()

    print("\n=== Summary ===")
    print(f"  search_articles sequential: p50={p50:.0f}ms p95={p95:.0f}ms")
    print("  (Record these numbers in docs/MCP_SERVER_TESTING.md sign-off table)")


if __name__ == "__main__":
    asyncio.run(main())
