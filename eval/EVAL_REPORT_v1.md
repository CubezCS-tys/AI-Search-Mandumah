# Evaluation Report — Baseline v1
**Date:** 2026-05-16  
**Testset:** `eval/testset.csv` — 150 QA pairs  
**Retrieval:** Hybrid search (dense + sparse + RRF rerank), top-10 retrieved, top-5 sent to RAGAS  
**Eval model:** `gpt-4o-mini`  
**Embedding model:** `text-embedding-3-small` (1536-dim)  
**Collection:** `academic_articles_v2` — 852,440 chunks

---

## 1. Results Summary

| Metric | Mean | Median | Std | Min | Max |
|---|---|---|---|---|---|
| **Context Recall** | **0.680** | 1.000 | 0.395 | 0.00 | 1.00 |
| **Context Precision** | **0.660** | 0.756 | 0.344 | 0.00 | 1.00 |
| **Faithfulness** | **0.953** | 1.000 | 0.117 | 0.00 | 1.00 |

### Score distributions

| Range | Context Recall | Context Precision | Faithfulness |
|---|---|---|---|
| 0–25% | 3 | 6 | 0 |
| 25–50% | 18 | 23 | 0 |
| 50–75% | 17 | 24 | 6 |
| 75–100% | 82 | 76 | 143 |

**Key observations at a glance:**
- 77/150 samples achieved **perfect recall (1.0)** — more than half the time every needed piece of information was retrieved
- **Precision never reached 1.0** across any of the 150 samples — at least one irrelevant chunk always appeared in the top-5
- 143/150 samples had faithfulness ≥ 0.75 — retrieved content is almost always factually grounded

---

## 2. What the Metrics Mean

**Context Recall** measures whether the reference answer's key statements are *present* in the retrieved chunks. A score of 0.68 means on average 68% of the information needed to answer a question was found in the top-5 results.

**Context Precision** measures whether the retrieved chunks are *ranked well* — are the relevant chunks appearing before the irrelevant ones? The 0.66 score with a max of 0.0 and a precision ceiling that never reaches 1.0 indicates the reranker is consistently letting some noise through to the top positions.

**Faithfulness** measures whether the retrieved chunks support the generated answer without hallucination. At 0.953 this is a strong signal — the retrieval system is not returning misleading or contradictory information.

---

## 3. Zero-Recall Failure Analysis (30 samples)

30 out of 150 samples scored exactly 0.0 on recall. These break down into identifiable categories:

### 3a. Testset generation noise (~40% of failures)
RAGAS generated questions from document metadata and reference sections rather than body content. These are unanswerable by any content retrieval system:

- *"ما هي نتائج اختبار 'ت'... في المجلد (٣٩) العدد (٨٩) الجزء (٣) ابريل ٢٠٢٤؟"* — asks about a specific volume/issue number appearing in a citation
- *"ما هي أهمية المجلد ٤٠ - العدد الثانى عشر - ديسمبر ٢٠٢٤م في مجال التعليم الذكي؟"* — journal metadata as a question
- *"ما هي المعلومات المتعلقة بالمجلة المنهل الإقتصادي في السياق المذكور؟"* — asking about the journal itself, not its content

**Impact:** These inflate the failure count artificially. True recall is likely 0.73–0.78 after removing these cases.

### 3b. Proper-noun / author factoid lookups (~30% of failures)
Questions about people named only in reference lists — not indexed body content:

- *"من هو فؤاد الأول؟"*
- *"من هو مهدي محمد ناصر الدين؟"*
- *"Who is Karumuri in the context of job satisfaction?"*
- *"ما هو دور محمد سليمان النور في القضايا القانونية؟"*

The chunker correctly strips reference sections (`المراجع`, `References`) before indexing, so these are fundamentally unretrievable. This is correct behaviour — not a bug.

### 3c. Gulf/Iraqi dialect questions (~15% of failures)
RAGAS synthesized questions in Kuwaiti/Iraqi dialect:

- *"شنو يعني Klimmt في سياق الإجهاد الرقمي؟"* (شنو = ما)
- *"شنو تأثير العمالة الوافدة على دولة الكويت؟"*
- *"شنو دور جامعة نايف العربية للعلوم الأمنية؟"*

The Arabic normalizer (`normalize_arabic`) handles letter unification (أإآ→ا, ى→ي, ة→ه) but does not map dialect vocabulary to MSA. Queries with "شنو" instead of "ما" fail to match chunks that use MSA vocabulary.

### 3d. Hyper-specific institutional references (~15% of failures)
Questions about institutions mentioned only in passing (footnotes, affiliations):

- *"ما هو دور مصنع السكر الجنايد في صناعة السكر في السودان؟"*
- *"ما هي جامعة شقراء في سياق إدارة الموارد البشرية الخضراء؟"*

The reference document discusses these entities briefly; the question RAGAS generated requires background knowledge not present in the chunk.

---

## 4. Partial Recall Analysis

18 samples scored between 0.25–0.50. The most common pattern:

- **Split-document answers** — the reference answer spans two sections/chunks from the same document, but only one chunk was retrieved (e.g., methodology in one chunk, results in another)
- **Cross-document synthesis** — questions like *"كيف يؤثر التلوث على التغيرات المناخية"* require aggregating information from multiple documents; the system retrieves relevant content but not all of it
- **Language mixing** — *"Pourquoi Italie est mentionné..."* (French question over Arabic corpus) scored 0.5; the system retrieved the right document but missed half the reference statements

---

## 5. Precision Never Reaches 1.0

This is the most actionable signal from the evaluation. Even when recall is perfect (77 samples), precision is always < 1.0. This means the reranker consistently places at least one low-relevance chunk before some high-relevance ones.

The current reranker weights are: 45% semantic + 25% rank prior + 30% lexical coverage. The 30% lexical weight biases toward chunks that *contain query tokens* even when they are not topically relevant (e.g., a chunk mentioning "جامعة" scores high for any university-related query regardless of whether it answers the question).

---

## 6. Faithfulness Anomaly (6 samples in 50–75%)

Six samples had faithfulness between 0.50–0.75. This is unusual — it means the top retrieved chunk (used as the proxy "response") contained statements that the LLM judged as not fully supported by the retrieved context. Likely causes:

- The top-ranked chunk is a highly abstract section header or introduction that makes broad claims not evidenced within the same chunk
- Cross-chunk reasoning: the "answer" chunk refers to findings detailed in a different chunk

---

## 7. Suggestions for Improvement

### 7.1 Fix the testset (immediate, high impact)
Re-filter `eval/testset.csv` to remove questions that are clearly about metadata, journal names, or authors. Keep only questions answerable from document body content. Estimated true recall after cleaning: **~0.74–0.78**.

A simple filter: drop rows where `user_input` contains patterns like `المجلد`, `العدد`, `الجزء`, `ISSN`, or where the reference answer is under 50 characters.

### 7.2 Add dialect normalization to the query pipeline (medium effort, high impact)
Extend `normalize_arabic()` in `backend/utils/arabic.py` to map common Gulf/Levantine/Egyptian dialect words to MSA equivalents before embedding and sparse encoding:

```python
DIALECT_MAP = {
    "شنو": "ما",   # Iraqi/Kuwaiti "what"
    "شلون": "كيف", # Iraqi "how"
    "وين": "أين",  # Gulf "where"
    "ليش": "لماذا", # Levantine "why"
    "شو":  "ما",   # Levantine "what"
}
```

This would recover the ~15% of zero-recall failures caused by dialect mismatch at essentially zero cost.

### 7.3 Tune reranker weights (medium effort, measurable impact)
Context precision 0.66 with a hard ceiling below 1.0 points to the reranker's lexical weight being too aggressive. Suggested experiment:

| Configuration | Semantic | Rank Prior | Lexical |
|---|---|---|---|
| Current (baseline) | 45% | 25% | 30% |
| Experiment A | 55% | 25% | 20% |
| Experiment B | 60% | 20% | 20% |

Run `evaluate --testset eval/testset.csv` (same fixed testset) after each change and compare precision scores. Do not regenerate the testset — same CSV must be used for all A/B comparisons.

### 7.4 Increase chunks sent to RAGAS for evaluation (low effort)
Currently top-5 chunks are sent to RAGAS (reduced from 10 to avoid token limits). Consider using `gpt-4o` instead of `gpt-4o-mini` as the eval model to support longer contexts. This would allow evaluating with top-10 chunks and give a more accurate picture of recall at the full retrieval depth.

Alternatively, keep `gpt-4o-mini` but pass `max_tokens=16000` — Arabic structured output generation at this scale needs the full output budget.

### 7.5 Add a split-chunk retrieval mode (longer term)
For queries that require multi-chunk answers from the same document, consider a "document expansion" mode: when a chunk is retrieved, also fetch the immediately adjacent chunks (chunk_index ± 1) from the same `doc_id`. This would improve recall on the 18 partial-recall cases caused by split-document answers.

### 7.6 Evaluate sparse-only and dense-only modes (low effort, diagnostic)
Run `evaluate --testset eval/testset.csv` with `mode="dense"` and `mode="sparse"` to understand the contribution of each retrieval mode. This will confirm whether hybrid is actually outperforming single-mode retrieval on this corpus.

---

## 8. Evaluation Setup Notes

- Testset was generated using `SingleHopSpecificQuerySynthesizer` from 200 diverse chunks (one per document)
- RAGAS `batch_score()` API used directly (new `metrics.collections` namespace, not legacy `ragas.evaluate()`)
- `AsyncOpenAI` client required; sync client causes `TypeError` in `agenerate()`
- `rapidfuzz` required for `OverlapScoreBuilder` — install with `pip install rapidfuzz`
- `max_tokens=8192` passed to `llm_factory` to avoid output truncation on Arabic structured output generation

---

## 9. How to Re-run

```bash
# Evaluate against the fixed testset (A/B comparisons)
python -m eval.ragas_eval evaluate --testset eval/testset.csv --top-k 10

# Regenerate testset and evaluate end-to-end (new baseline)
python -m eval.ragas_eval all --n-chunks 200 --testset-size 150 --top-k 10
```

**Important:** Always use `evaluate` (not `all`) when comparing system changes. Regenerating the testset changes the questions and makes scores incomparable.
