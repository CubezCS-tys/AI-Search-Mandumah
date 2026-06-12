"""
Unit tests for the --input-jsonl content-shard ingestion mode.

All tests are marked @pytest.mark.unit — no network, no Qdrant, no OpenAI.
The embedder is faked and runs use dry_run or no_write.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from backend.pipeline.ingest import (
    _dry_run_scan,
    _extract_metadata_from_id,
    _find_shards,
    _iter_shard_docs,
    ingest_documents,
)

pytestmark = pytest.mark.unit

# Long enough to clear the 100-char minimum and produce at least one chunk
ARABIC_PARA = (
    "لقد شهد العالم المعاصر اهتماماً واسعاً بمصطلح اقتصاد المعرفة وشهد هذا "
    "المفهوم تطوراً كبيراً مع اتساع استخدام شبكة الإنترنت والتجارة الإلكترونية. "
)


def _make_shard(path: Path, docs: list[dict], compress: bool = True) -> None:
    opener = gzip.open if compress else open
    with opener(path, "wt", encoding="utf-8") as f:
        for d in docs:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")


def _doc(doc_id: str, batch: str = "output_batch99", paras: int = 8) -> dict:
    return {"doc_id": doc_id, "batch": batch, "content": ARABIC_PARA * paras}


# ── Shard discovery ───────────────────────────────────────────────────────


def test_find_shards_filters_extensions(tmp_path):
    _make_shard(tmp_path / "a.jsonl.gz", [_doc("0001-001-001-001")])
    _make_shard(tmp_path / "b.jsonl", [_doc("0001-001-001-002")], compress=False)
    (tmp_path / "extract_manifest.json").write_text("{}")
    (tmp_path / "c.jsonl.gz.tmp").write_text("partial")
    (tmp_path / "notes.txt").write_text("x")

    shards = _find_shards(tmp_path)
    assert [s.name for s in shards] == ["a.jsonl.gz", "b.jsonl"]


# ── Record iteration ──────────────────────────────────────────────────────


def test_iter_shard_docs_yields_records_with_metadata(tmp_path):
    _make_shard(tmp_path / "s.jsonl.gz", [_doc("1951-010-003-010")])
    progress = {"failed": []}

    records = list(_iter_shard_docs(_find_shards(tmp_path), set(), progress))
    assert len(records) == 1
    doc_id, content, meta, fhash = records[0]
    assert doc_id == "1951-010-003-010"
    assert content.startswith("لقد شهد")
    assert meta["journal_id"] == "1951"
    assert meta["volume"] == "010"
    assert meta["issue"] == "003"
    assert meta["article_num"] == "010"
    assert meta["batch"] == "output_batch99"
    assert fhash is None
    assert progress["failed"] == []


def test_iter_shard_docs_skips_processed(tmp_path):
    _make_shard(
        tmp_path / "s.jsonl.gz",
        [_doc("0001-001-001-001"), _doc("0001-001-001-002")],
    )
    progress = {"failed": []}
    processed = {"0001-001-001-001"}

    records = list(_iter_shard_docs(_find_shards(tmp_path), processed, progress))
    assert [r[0] for r in records] == ["0001-001-001-002"]


def test_iter_shard_docs_bad_line_is_logged_not_fatal(tmp_path):
    shard = tmp_path / "s.jsonl"
    shard.write_text(
        json.dumps(_doc("0001-001-001-001"), ensure_ascii=False)
        + "\nnot json at all\n"
        + json.dumps(_doc("0001-001-001-002"), ensure_ascii=False)
        + "\n"
    )
    progress = {"failed": []}

    records = list(_iter_shard_docs([shard], set(), progress))
    assert [r[0] for r in records] == ["0001-001-001-001", "0001-001-001-002"]
    assert progress["failed"] == ["s.jsonl:2"]


def test_extract_metadata_from_id_non_standard():
    meta = _extract_metadata_from_id("weird_id")
    assert meta == {"doc_id": "weird_id"}


# ── Dry-run scan ──────────────────────────────────────────────────────────


def test_dry_run_scan_counts_and_dedup(tmp_path):
    # Two docs with identical content: second one's chunks are duplicates
    _make_shard(
        tmp_path / "s.jsonl.gz",
        [_doc("0001-001-001-001"), _doc("0001-001-001-002")],
    )
    progress = {"failed": []}
    records = _iter_shard_docs(_find_shards(tmp_path), set(), progress)

    stats = _dry_run_scan(records, para_hashes=set())
    assert stats["total_docs"] == 2
    assert stats["new_files"] == 2
    assert stats["total_paras"] > 0
    assert stats["dup_paras"] > 0
    assert stats["unique_paras"] == stats["total_paras"] - stats["dup_paras"]


# ── Orchestrator ──────────────────────────────────────────────────────────


def test_ingest_requires_exactly_one_input():
    with pytest.raises(ValueError):
        ingest_documents()
    with pytest.raises(ValueError):
        ingest_documents(input_dir="a", input_jsonl="b")


def test_ingest_dry_run_jsonl(tmp_path):
    _make_shard(tmp_path / "s.jsonl.gz", [_doc("0001-001-001-001")])
    # Completes without touching OpenAI or Qdrant
    ingest_documents(input_jsonl=str(tmp_path), dry_run=True)
    # Dry run must not write checkpoint state
    assert not (tmp_path / "ingest_checkpoint.json").exists()


class _FakeEmbedder:
    model = "fake-embedding-model"

    def __init__(self, **kwargs):
        pass

    def encode(self, texts):
        return [object()] * len(texts)


def test_ingest_no_write_jsonl_checkpoints_docs(tmp_path, monkeypatch):
    import backend.pipeline.embedder as embedder_mod

    monkeypatch.setattr(embedder_mod, "OpenAIEmbedder", _FakeEmbedder)

    doc_ids = [f"0001-001-001-{n:03d}" for n in range(1, 4)]
    _make_shard(tmp_path / "s.jsonl.gz", [_doc(d, paras=8 + i) for i, d in enumerate(doc_ids)])

    ingest_documents(input_jsonl=str(tmp_path), no_write=True)

    checkpoint = json.loads((tmp_path / "ingest_checkpoint.json").read_text())
    assert sorted(checkpoint["processed"]) == doc_ids
    assert checkpoint["failed"] == []
    manifest = json.loads((tmp_path / "ingest_manifest.json").read_text())
    assert manifest["docs_processed"] == 3
    assert manifest["total_chunks_embedded"] > 0

    # Second run resumes: everything already processed, nothing re-embedded
    ingest_documents(input_jsonl=str(tmp_path), no_write=True)
    manifest2 = json.loads((tmp_path / "ingest_manifest.json").read_text())
    assert manifest2["docs_processed"] == 0
    checkpoint2 = json.loads((tmp_path / "ingest_checkpoint.json").read_text())
    assert sorted(checkpoint2["processed"]) == doc_ids
