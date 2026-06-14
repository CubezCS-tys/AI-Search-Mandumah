#!/usr/bin/env python3
"""
Stream a MARC21-slim XML catalogue into a compact SQLite metadata sidecar.

The corpus ships with one giant MARCXML file (multiple GB) holding one
<record> per article. This script streams it with constant memory
(xml.etree.iterparse, clearing each record) and writes a SQLite database
keyed by ``doc_id`` — the stem of the PDF filename in datafield 856$u, which
is exactly the identifier the ingestion pipeline already uses.

The resulting DB is tiny relative to the XML (no layout, only the bibliographic
fields we need) and gives the ingester O(1) lookups per document without
loading anything into RAM.

Stdlib only — runs anywhere the XML lives (e.g. the server), no pip installs.

Field mapping (verified against the real corpus, 303k-record sample):
    doc_id        856$u (filename stem)         join key, 100%
    record_id     001                           catalogue id, 100%
    title         245$a (+ ": " 245$b subtitle) 100%
    keywords      653$a (repeatable)            ~100%, ~9/record   [JSON list]
    abstract      520$a | 520$e/$d/$f           Arabic abstract, ~7%
    abstract_en   520$b                          English abstract
    authors       100$a + 700$a (repeatable)    personal authors   [JSON list]
    corp_author   110$a                          corporate author
    journal       773$s                          journal title (ar), 100%
    journal_en    773$t                          journal title (en)
    category      773$4                          subject category (ar)
    category_en   773$6                          subject category (en)
    issn          773$x
    volume        773$v
    issue         773$l
    year          260$c
    month         260$g
    publisher     260$b
    country       044$b
    pages         300$a
    database      995$a (repeatable)            source DB          [JSON list]
    content_type  336$a
    doi           024$3                          DOI (e.g. 10.34120/...)

Usage:
    python3 extract_marc_metadata.py --xml /path/metadata.xml --db marc_metadata.db
    python3 extract_marc_metadata.py --xml sample2.xml --db marc.db --limit 1000
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

MARC_NS = "http://www.loc.gov/MARC21/slim"
REC_TAG = f"{{{MARC_NS}}}record"
CF_TAG = f"{{{MARC_NS}}}controlfield"
DF_TAG = f"{{{MARC_NS}}}datafield"
SF_TAG = f"{{{MARC_NS}}}subfield"

# Columns stored as JSON-encoded lists (everything else is a plain string).
LIST_COLS = ("keywords", "authors", "database")

# (column, sqlite type) — order defines the table and the INSERT tuple.
COLUMNS: list[tuple[str, str]] = [
    ("doc_id", "TEXT PRIMARY KEY"),
    ("record_id", "TEXT"),
    ("title", "TEXT"),
    ("keywords", "TEXT"),
    ("abstract", "TEXT"),
    ("abstract_en", "TEXT"),
    ("authors", "TEXT"),
    ("corp_author", "TEXT"),
    ("journal", "TEXT"),
    ("journal_en", "TEXT"),
    ("category", "TEXT"),
    ("category_en", "TEXT"),
    ("issn", "TEXT"),
    ("volume", "TEXT"),
    ("issue", "TEXT"),
    ("year", "TEXT"),
    ("month", "TEXT"),
    ("publisher", "TEXT"),
    ("country", "TEXT"),
    ("pages", "TEXT"),
    ("database", "TEXT"),
    ("content_type", "TEXT"),
    ("doi", "TEXT"),
]
COL_NAMES = [c for c, _ in COLUMNS]


def _field_map(rec: ET.Element) -> tuple[dict[str, str], dict[tuple[str, str], list[str]]]:
    """Walk a <record> once, returning (controlfields, {(tag,code): [values]})."""
    cf: dict[str, str] = {}
    df: dict[tuple[str, str], list[str]] = {}
    for child in rec:
        if child.tag == CF_TAG:
            tag = child.get("tag", "")
            text = (child.text or "").strip()
            if text:
                cf[tag] = text
        elif child.tag == DF_TAG:
            tag = child.get("tag", "")
            for sf in child:
                if sf.tag != SF_TAG:
                    continue
                val = (sf.text or "").strip()
                if val:
                    df.setdefault((tag, sf.get("code", "")), []).append(val)
    return cf, df


def _record_to_row(rec: ET.Element) -> dict | None:
    """Map one MARC <record> to a column dict, or None if it has no filename."""
    cf, df = _field_map(rec)

    def first(tag: str, code: str) -> str:
        vals = df.get((tag, code))
        return vals[0] if vals else ""

    def joined(tag: str, code: str, sep: str = " ") -> str:
        return sep.join(df.get((tag, code), []))

    def lst(*pairs: tuple[str, str]) -> list[str]:
        out: list[str] = []
        for tag, code in pairs:
            out.extend(df.get((tag, code), []))
        # de-dup, preserve order
        seen: set[str] = set()
        return [x for x in out if not (x in seen or seen.add(x))]

    filenames = df.get(("856", "u"), [])
    if not filenames:
        return None
    doc_id = Path(filenames[0]).stem
    if not doc_id:
        return None

    # Title: main + optional subtitle.
    title = first("245", "a")
    subtitle = first("245", "b")
    if subtitle:
        title = f"{title}: {subtitle}" if title else subtitle

    # Abstract: Arabic prose lives in $a, with $e/$d/$f as occasional carriers.
    abstract = joined("520", "a") or first("520", "e") or first("520", "d") or first("520", "f")

    return {
        "doc_id": doc_id,
        "record_id": cf.get("001", ""),
        "title": title,
        "keywords": lst(("653", "a")),
        "abstract": abstract,
        "abstract_en": joined("520", "b"),
        "authors": lst(("100", "a"), ("700", "a")),
        "corp_author": joined("110", "a", "؛ "),
        "journal": first("773", "s"),
        "journal_en": first("773", "t"),
        "category": first("773", "4"),
        "category_en": first("773", "6"),
        "issn": first("773", "x"),
        "volume": first("773", "v"),
        "issue": first("773", "l"),
        "year": first("260", "c"),
        "month": first("260", "g"),
        "publisher": first("260", "b"),
        "country": first("044", "b"),
        "pages": first("300", "a"),
        "database": lst(("995", "a")),
        "content_type": first("336", "a"),
        "doi": first("024", "3"),
    }


def _row_to_tuple(row: dict) -> tuple:
    """Serialise a row dict into the column order, JSON-encoding list columns."""
    out = []
    for name in COL_NAMES:
        val = row.get(name)
        if name in LIST_COLS:
            out.append(json.dumps(val, ensure_ascii=False) if val else "")
        else:
            out.append(val or "")
    return tuple(out)


def _init_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    cols_sql = ", ".join(f'"{name}" {decl}' for name, decl in COLUMNS)
    conn.execute(f"CREATE TABLE IF NOT EXISTS marc ({cols_sql})")
    return conn


def extract(xml_path: Path, db_path: Path, limit: int = 0, commit_every: int = 5000) -> dict:
    conn = _init_db(db_path)
    placeholders = ", ".join("?" for _ in COL_NAMES)
    insert_sql = f"INSERT OR IGNORE INTO marc ({', '.join(COL_NAMES)}) VALUES ({placeholders})"

    stats = {
        "records": 0, "rows_written": 0, "no_filename": 0, "dup_doc_id": 0,
        "with_abstract": 0, "with_keywords": 0, "with_author": 0,
        "with_title": 0, "with_journal": 0,
    }
    batch: list[tuple] = []
    t0 = time.time()

    # events=("start","end"): grab the root on the first start so we can prune
    # finished records' siblings and keep memory flat.
    context = ET.iterparse(str(xml_path), events=("start", "end"))
    _, root = next(context)  # the <collection> root

    for event, elem in context:
        if event != "end" or elem.tag != REC_TAG:
            continue
        stats["records"] += 1
        row = _record_to_row(elem)
        if row is not None:
            stats["with_title"] += bool(row["title"])
            stats["with_abstract"] += bool(row["abstract"] or row["abstract_en"])
            stats["with_keywords"] += bool(row["keywords"])
            stats["with_author"] += bool(row["authors"] or row["corp_author"])
            stats["with_journal"] += bool(row["journal"])
            batch.append(_row_to_tuple(row))
        else:
            stats["no_filename"] += 1

        # Free the record and drop it from the root so memory stays flat.
        # (stdlib ElementTree keeps every parsed child under root otherwise.)
        elem.clear()
        root.clear()

        if len(batch) >= commit_every:
            before = conn.total_changes
            conn.executemany(insert_sql, batch)
            conn.commit()
            stats["rows_written"] += conn.total_changes - before
            stats["dup_doc_id"] += len(batch) - (conn.total_changes - before)
            batch.clear()
            rate = stats["records"] / (time.time() - t0)
            print(f"  {stats['records']:,} records | {stats['rows_written']:,} rows "
                  f"| {rate:,.0f} rec/s", flush=True)

        if limit and stats["records"] >= limit:
            break

    if batch:
        before = conn.total_changes
        conn.executemany(insert_sql, batch)
        conn.commit()
        stats["rows_written"] += conn.total_changes - before
        stats["dup_doc_id"] += len(batch) - (conn.total_changes - before)

    conn.execute("CREATE INDEX IF NOT EXISTS idx_doc_id ON marc(doc_id)")
    conn.commit()
    conn.close()
    stats["elapsed_sec"] = round(time.time() - t0, 1)
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 2)[1])
    ap.add_argument("--xml", required=True, type=Path, help="Path to the MARCXML file")
    ap.add_argument("--db", required=True, type=Path, help="Output SQLite path")
    ap.add_argument("--limit", type=int, default=0, help="Stop after N records (testing)")
    args = ap.parse_args()

    if not args.xml.is_file():
        print(f"error: xml not found: {args.xml}", file=sys.stderr)
        return 1

    print(f"streaming {args.xml} -> {args.db}")
    stats = extract(args.xml, args.db, limit=args.limit)

    manifest = args.db.with_suffix(args.db.suffix + ".manifest.json")
    manifest.write_text(json.dumps({"xml": str(args.xml), **stats}, ensure_ascii=False, indent=2))

    def pct(n: int) -> str:
        return f"{n:,} ({n / max(stats['rows_written'], 1) * 100:.1f}%)"

    print("\ndone:")
    print(f"  records read:   {stats['records']:,}")
    print(f"  rows written:   {stats['rows_written']:,}")
    print(f"  no filename:    {stats['no_filename']:,}")
    print(f"  dup doc_id:     {stats['dup_doc_id']:,}")
    print(f"  with title:     {pct(stats['with_title'])}")
    print(f"  with keywords:  {pct(stats['with_keywords'])}")
    print(f"  with abstract:  {pct(stats['with_abstract'])}")
    print(f"  with author:    {pct(stats['with_author'])}")
    print(f"  with journal:   {pct(stats['with_journal'])}")
    print(f"  elapsed:        {stats['elapsed_sec']}s")
    print(f"  manifest:       {manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
