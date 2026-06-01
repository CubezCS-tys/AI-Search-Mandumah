"""
Embedding module supporting BGE-M3 (legacy) and OpenAI text-embedding-3-small.

OpenAI embedder:
  - Dense (1536d) via OpenAI API with async concurrency
  - Sparse via TF-IDF-style hash vectorizer (for hybrid search)
  - AsyncRateLimiter + semaphore for safe concurrent API calls
  - Exponential backoff on rate limit errors

BGE-M3 (legacy, kept for rollback):
  - Dense (1024d) + sparse (learned) in a single local forward pass
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import Counter
from dataclasses import dataclass
from typing import Sequence

import mmh3

logger = logging.getLogger(__name__)


@dataclass
class EmbeddingResult:
    """Dense + sparse embedding pair for a single text."""
    dense: list[float]           # 1024-dim dense vector
    sparse_indices: list[int]    # Non-zero indices for sparse vector
    sparse_values: list[float]   # Corresponding values


class BGEm3Embedder:
    """
    Wrapper around BGE-M3 model for generating dense + sparse embeddings.

    Usage:
        embedder = BGEm3Embedder()
        results = embedder.encode(["text1", "text2"])
        # results[0].dense -> [0.023, -0.041, ...]
        # results[0].sparse_indices -> [42, 156, ...]
        # results[0].sparse_values -> [0.8, 0.3, ...]
    """

    def __init__(
        self,
        model_name: str = "BAAI/bge-m3",
        batch_size: int = 32,
        max_length: int = 8192,
        use_fp16: bool = True,
        device: str | None = None,
    ):
        self.model_name = model_name
        self.batch_size = batch_size
        self.max_length = max_length
        self._model = None
        self._use_fp16 = use_fp16
        self._device = device

    def _load_model(self):
        if self._model is not None:
            return

        logger.info("Loading BGE-M3 model: %s", self.model_name)
        from FlagEmbedding import BGEM3FlagModel

        self._model = BGEM3FlagModel(
            self.model_name,
            use_fp16=self._use_fp16,
            device=self._device,
        )
        logger.info("BGE-M3 model loaded successfully")

    def encode(
        self,
        texts: Sequence[str],
        *,
        batch_size: int | None = None,
        return_colbert: bool = False,
    ) -> list[EmbeddingResult]:
        """
        Encode texts into dense + sparse embeddings.

        Args:
            texts: List of texts to encode.
            batch_size: Override default batch size.
            return_colbert: Whether to also compute ColBERT vectors (slower).

        Returns:
            List of EmbeddingResult, one per input text.
        """
        self._load_model()

        bs = batch_size or self.batch_size
        output = self._model.encode(
            list(texts),
            batch_size=bs,
            max_length=self.max_length,
            return_dense=True,
            return_sparse=True,
            return_colbert_vecs=return_colbert,
        )

        dense_vecs = output["dense_vecs"]       # numpy array (N, 1024)
        sparse_dicts = output["lexical_weights"]  # list of dicts {token_id: weight}

        results = []
        for i in range(len(texts)):
            dense = dense_vecs[i].tolist()

            # Convert sparse dict to indices + values
            sparse_dict = sparse_dicts[i]
            indices = sorted(sparse_dict.keys())
            values = [float(sparse_dict[idx]) for idx in indices]

            results.append(EmbeddingResult(
                dense=dense,
                sparse_indices=[int(idx) for idx in indices],
                sparse_values=values,
            ))

        return results

    def encode_queries(
        self,
        queries: Sequence[str],
        *,
        batch_size: int | None = None,
    ) -> list[EmbeddingResult]:
        """
        Encode queries - same as encode but may use different model internals
        for asymmetric search (query vs document).
        """
        # BGE-M3 handles this internally via the same encode method
        return self.encode(queries, batch_size=batch_size)


# ── Sparse Vectorizer (TF-IDF hash) ────────────────────────────────────


SPARSE_VOCAB_SIZE = 30_000


class SparseVectorizer:
    """Generate sparse vectors using term-frequency with hash-based indices.

    Tokens are normalized with shared Arabic utilities, then each token is
    mapped to a stable integer index via ``mmh3.hash(token) % SPARSE_VOCAB_SIZE``.
    Uses mmh3 (MurmurHash3) for deterministic hashing across processes.
    Qdrant's ``Modifier.IDF`` applies IDF weighting server-side at query time.
    """

    def __init__(self, vocab_size: int = SPARSE_VOCAB_SIZE):
        self.vocab_size = vocab_size

    def vectorize(self, text: str) -> tuple[list[int], list[float]]:
        from backend.utils.arabic import tokenize_arabic

        tokens = tokenize_arabic(text, remove_stopwords=True)
        if not tokens:
            return [], []

        counts = Counter(tokens)
        total = len(tokens)

        buckets: dict[int, float] = {}
        for token, count in counts.items():
            idx = mmh3.hash(token, signed=False) % self.vocab_size
            tf = count / total
            buckets[idx] = buckets.get(idx, 0.0) + tf

        indices = sorted(buckets.keys())
        values = [buckets[i] for i in indices]
        return indices, values


# ── Async Rate Limiter ──────────────────────────────────────────────────


class AsyncRateLimiter:
    """Sliding-window rate limiter for async OpenAI API calls."""

    def __init__(self, max_requests_per_minute: int):
        self.max_requests = max_requests_per_minute
        self.requests: list[float] = []
        self.lock = asyncio.Lock()

    async def wait_if_needed(self):
        wait_time = 0
        async with self.lock:
            now = time.time()
            self.requests = [t for t in self.requests if now - t < 60]
            if len(self.requests) >= self.max_requests:
                oldest = min(self.requests)
                wait_time = 60 - (now - oldest) + 0.1
        if wait_time > 0:
            logger.info("Rate limit reached, waiting %.1fs...", wait_time)
            await asyncio.sleep(wait_time)
        async with self.lock:
            self.requests.append(time.time())


# ── OpenAI Embedder ─────────────────────────────────────────────────────


class OpenAIEmbedder:
    """
    Async OpenAI embedder producing dense (1536d) + sparse vectors.

    Dense vectors come from the OpenAI API (text-embedding-3-small).
    Sparse vectors are generated locally via SparseVectorizer.

    Supports concurrent API requests controlled by a semaphore and
    a sliding-window rate limiter.

    Usage:
        embedder = OpenAIEmbedder()
        results = embedder.encode(["text1", "text2"])
        # results[0].dense -> [0.023, -0.041, ...]  (1536-dim)
        # results[0].sparse_indices -> [42, 156, ...]
        # results[0].sparse_values -> [0.8, 0.3, ...]
    """

    def __init__(
        self,
        model: str | None = None,
        batch_size: int = 100,
        max_concurrent: int | None = None,
        requests_per_minute: int | None = None,
        max_retries: int = 5,
        retry_base_delay: float = 2.0,
    ):
        self.model = model or os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
        self.batch_size = batch_size
        self.max_concurrent = max_concurrent or int(
            os.getenv("MAX_CONCURRENT_REQUESTS", "10")
        )
        self.requests_per_minute = requests_per_minute or int(
            os.getenv("REQUESTS_PER_MINUTE", "2950")
        )
        self.max_retries = max_retries
        self.retry_base_delay = retry_base_delay
        self._sparse = SparseVectorizer()
        self._rate_limiter = AsyncRateLimiter(self.requests_per_minute)
        self._client = None

    def _get_async_client(self):
        if self._client is None:
            import openai

            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                raise RuntimeError("OPENAI_API_KEY environment variable is not set")
            self._client = openai.AsyncOpenAI(api_key=api_key)
        return self._client

    async def _embed_batch_async(
        self,
        texts: list[str],
        rate_limiter: AsyncRateLimiter,
        semaphore: asyncio.Semaphore,
    ) -> list[list[float]]:
        """Call OpenAI API for a single batch with retries."""
        async with semaphore:
            for attempt in range(self.max_retries):
                try:
                    await rate_limiter.wait_if_needed()
                    client = self._get_async_client()
                    response = await client.embeddings.create(
                        input=texts,
                        model=self.model,
                    )
                    sorted_data = sorted(response.data, key=lambda item: item.index)
                    return [item.embedding for item in sorted_data]
                except Exception as e:
                    import openai as _oai
                    if isinstance(e, (_oai.AuthenticationError, _oai.BadRequestError)):
                        logger.error("OpenAI fatal error (no retry): %s", e)
                        raise
                    if attempt < self.max_retries - 1:
                        wait = self.retry_base_delay * (2 ** attempt)
                        logger.warning(
                            "OpenAI API error (attempt %d/%d): %s — retrying in %.1fs",
                            attempt + 1,
                            self.max_retries,
                            e,
                            wait,
                        )
                        await asyncio.sleep(wait)
                    else:
                        logger.error("OpenAI API error after %d retries: %s", self.max_retries, e)
                        raise
        return []  # unreachable

    async def _encode_async(
        self,
        texts: Sequence[str],
        batch_size: int | None = None,
    ) -> list[EmbeddingResult]:
        """Encode texts using concurrent async OpenAI API calls."""
        text_list = list(texts)
        bs = batch_size or self.batch_size

        semaphore = asyncio.Semaphore(self.max_concurrent)

        # Fire all batches concurrently
        tasks = []
        for i in range(0, len(text_list), bs):
            batch = text_list[i : i + bs]
            tasks.append(self._embed_batch_async(batch, self._rate_limiter, semaphore))

        batch_results = await asyncio.gather(*tasks)

        # Flatten dense vectors
        all_dense = []
        for batch_dense in batch_results:
            all_dense.extend(batch_dense)

        # Generate sparse vectors locally
        results = []
        for i, text in enumerate(text_list):
            sparse_indices, sparse_values = self._sparse.vectorize(text)
            results.append(EmbeddingResult(
                dense=all_dense[i],
                sparse_indices=sparse_indices,
                sparse_values=sparse_values,
            ))

        return results

    def encode(
        self,
        texts: Sequence[str],
        *,
        batch_size: int | None = None,
    ) -> list[EmbeddingResult]:
        """
        Encode texts into dense + sparse embeddings (synchronous wrapper).

        Internally runs the async pipeline. Safe to call from sync code
        (e.g. the ingest pipeline's embed worker thread or the search service).
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            # Already inside an event loop — run in a new thread
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(
                    asyncio.run,
                    self._encode_async(texts, batch_size=batch_size),
                )
                return future.result()
        else:
            return asyncio.run(self._encode_async(texts, batch_size=batch_size))

    def encode_queries(
        self,
        queries: Sequence[str],
        *,
        batch_size: int | None = None,
    ) -> list[EmbeddingResult]:
        """Encode queries — same as encode (OpenAI embeddings are symmetric)."""
        return self.encode(queries, batch_size=batch_size)
