"""Quick validation of chunker against all sample documents."""

import json
import sys
from pathlib import Path

from pipeline.chunker import chunk_document


def main():
    output_dir = Path("output")
    if not output_dir.exists():
        print("No output/ directory found")
        sys.exit(1)

    total_docs = 0
    total_chunks = 0
    total_skipped_refs = 0
    chunk_sizes = []
    errors = []

    for journal_dir in sorted(output_dir.iterdir()):
        if not journal_dir.is_dir():
            continue
        for article_dir in sorted(journal_dir.iterdir()):
            if not article_dir.is_dir():
                continue
            json_file = article_dir / f"{article_dir.name}.json"
            if not json_file.exists():
                continue

            doc_id = json_file.stem
            try:
                with open(json_file) as f:
                    data = json.load(f)

                result = chunk_document(data["content"], doc_id)
                total_docs += 1
                total_chunks += len(result.chunks)
                total_skipped_refs += result.skipped_reference_chars
                chunk_sizes.extend(c.char_len for c in result.chunks)

                # Validate
                for c in result.chunks:
                    if c.char_len == 0:
                        errors.append(f"{doc_id}: empty chunk {c.chunk_id}")
                    if not c.embed_text.strip():
                        errors.append(f"{doc_id}: empty embed_text {c.chunk_id}")

            except Exception as e:
                errors.append(f"{doc_id}: {e}")

    print(f"Documents processed: {total_docs}")
    print(f"Total chunks: {total_chunks}")
    print(f"Avg chunks/doc: {total_chunks / max(total_docs, 1):.1f}")
    print(f"Avg chunk size: {sum(chunk_sizes) / max(len(chunk_sizes), 1):.0f} chars")
    print(f"Min chunk size: {min(chunk_sizes)} chars")
    print(f"Max chunk size: {max(chunk_sizes)} chars")
    print(f"Total ref chars skipped: {total_skipped_refs}")

    # Size distribution
    buckets = {"<400": 0, "400-800": 0, "800-1200": 0, "1200-1600": 0, "1600-2000": 0, "2000+": 0}
    for s in chunk_sizes:
        if s < 400: buckets["<400"] += 1
        elif s < 800: buckets["400-800"] += 1
        elif s < 1200: buckets["800-1200"] += 1
        elif s < 1600: buckets["1200-1600"] += 1
        elif s < 2000: buckets["1600-2000"] += 1
        else: buckets["2000+"] += 1

    print("\nChunk size distribution:")
    for bucket, count in buckets.items():
        pct = count / max(len(chunk_sizes), 1) * 100
        bar = "#" * int(pct / 2)
        print(f"  {bucket:>10}: {count:>5} ({pct:5.1f}%) {bar}")

    if errors:
        print(f"\nErrors ({len(errors)}):")
        for e in errors[:10]:
            print(f"  - {e}")

    print("\nDone!")


if __name__ == "__main__":
    main()
