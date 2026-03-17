"""
Embedding module using BGE-M3 for dense + sparse vectors.

BGE-M3 produces three types of embeddings in a single forward pass:
  - Dense (1024d) - for semantic similarity
  - Sparse (learned) - replaces BM25, better for Arabic morphology
  - (ColBERT multi-vector - skipped for now, can add later for reranking)

Uses FlagEmbedding library for the model, which handles batching internally.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Sequence

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
