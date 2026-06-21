// SSE fixture helpers. Frames are emitted as "data: <json>\n\n" so the REAL
// stream parser is exercised, not bypassed. The corpus-chat frame order mirrors
// the backend (corpus_chat.py): conversation_id, meta, sources, tokens, followups,
// then the [DONE] sentinel (meta/sources arrive BEFORE tokens, so Glass Brain is
// a replay of completed retrieval, not a live stream).

const enc = new TextEncoder();

/** Build a text/event-stream ReadableStream from ordered frames. The literal
 *  string "[DONE]" is emitted as the SSE done-sentinel. */
export function sseStream(frames: Array<unknown>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) {
        const payload = f === "[DONE]" ? "[DONE]" : JSON.stringify(f);
        controller.enqueue(enc.encode("data: " + payload + "\n\n"));
      }
      controller.close();
    },
  });
}

const ANSWER =
  "تشير الدراسات المسترجَعة إلى أثر إيجابي للتعلّم المقلوب في تنمية التفكير الناقد (م 1)، " +
  "مع تفاوت في حجم الأثر بحسب المرحلة الدراسية والمادة (م 2). وتبرز الحاجة إلى دراسات طولية أطول مدى.";

const tokenize = (s: string) => s.split(/(\s+)/).filter(Boolean).map((token) => ({ token }));

export const synthesisEvidence = [
  {
    doc_index: 1,
    doc_id: "2048-014-003-020",
    title: "أثر التعلّم المقلوب في تنمية مهارات التفكير الناقد لدى طلاب المرحلة الثانوية",
    research_focus: "قياس أثر التعلّم المقلوب على التفكير الناقد",
    methodology: "شبه تجريبي بمجموعتين تجريبية وضابطة",
    sample: "ثمانية وستون طالبًا",
    key_findings: [
      { claim: "تحسّن دال إحصائيًا في التفكير الناقد", evidence: "فروق لصالح المجموعة التجريبية", chunk_refs: [0, 2] },
    ],
    statistics: [{ value: "حجم الأثر 0.82", context: "إيتا تربيع", chunk_refs: [2] }],
    limitations: ["العيّنة محدودة الحجم", "اقتصار التطبيق على فصل دراسي واحد"],
    implications: ["الحاجة إلى دراسات طولية", "توسيع العيّنة لمراحل أخرى"],
    evidence_quality: "عالية",
    stance: "support" as const,
  },
  {
    doc_index: 2,
    doc_id: "2048-014-003-021",
    title: "فاعلية بيئات التعلّم الإلكترونية التشاركية في تحصيل الطلبة",
    research_focus: "أثر التعلّم التشاركي الإلكتروني على التحصيل",
    methodology: "وصفي ارتباطي",
    sample: "مئتان وأربعون طالبًا",
    key_findings: [
      { claim: "أثر إيجابي متوسط على التحصيل", evidence: "معامل ارتباط دال", chunk_refs: [1] },
    ],
    statistics: [{ value: "ارتباط 0.41", context: "بيرسون" }],
    limitations: ["الاعتماد على التقرير الذاتي"],
    implications: ["دمج أدوات تشاركية في المقررات"],
    evidence_quality: "متوسطة",
    stance: "mixed" as const,
  },
  {
    doc_index: 3,
    doc_id: "2048-014-003-022",
    title: "حدود فاعلية التعلّم المقلوب في المواد النظرية",
    research_focus: "نقد أثر التعلّم المقلوب في سياقات بعينها",
    methodology: "مراجعة منهجية",
    sample: "أربع عشرة دراسة",
    key_findings: [{ claim: "أثر غير دال في بعض المواد النظرية", chunk_refs: [3] }],
    statistics: [],
    limitations: ["تباين جودة الدراسات المُراجَعة"],
    implications: ["ضرورة ضبط متغيّرات المادة الدراسية"],
    evidence_quality: "متوسطة",
    stance: "contrast" as const,
  },
];

export const synthesizeFrames = (): unknown[] => [...tokenize(ANSWER), { evidence: synthesisEvidence }, "[DONE]"];

export const corpusSources = [
  {
    doc_id: "2048-014-003-020",
    title: "أثر التعلّم المقلوب في تنمية مهارات التفكير الناقد",
    chunk_id: "2048-014-003-020_chunk_000",
    score: 0.84,
    snippet: "أظهرت النتائج فروقًا دالة لصالح المجموعة التجريبية في التفكير الناقد.",
    section: "النتائج",
    journal_id: "2048",
    text: "أظهرت النتائج فروقًا دالة إحصائيًا لصالح المجموعة التجريبية في مهارات التفكير الناقد.",
  },
  {
    doc_id: "2048-014-003-021",
    title: "فاعلية بيئات التعلّم الإلكترونية التشاركية",
    chunk_id: "2048-014-003-021_chunk_001",
    score: 0.77,
    snippet: "ارتبط التعلّم التشاركي الإلكتروني بتحسّن متوسط في التحصيل.",
    section: "المناقشة",
    journal_id: "2048",
    text: "ارتبط التعلّم التشاركي الإلكتروني بتحسّن متوسط في التحصيل الدراسي.",
  },
];

export const corpusChatFrames = (deep = true): unknown[] => [
  { conversation_id: "conv_mock_1" },
  {
    meta: {
      rewritten_query: "أثر التعلّم المقلوب على التفكير الناقد في المرحلة الثانوية",
      sub_queries: deep
        ? ["أثر التعلّم المقلوب على التحصيل", "علاقة التعلّم المقلوب بالتفكير الناقد", "حدود التعلّم المقلوب"]
        : [],
      source_count: corpusSources.length,
      deep,
    },
  },
  { sources: corpusSources },
  ...tokenize(ANSWER),
  { followups: ["ما حجم الأثر في المواد العملية؟", "كيف يقارن بالتعلّم القائم على المشاريع؟"] },
  "[DONE]",
];

export const docChatFrames = (): unknown[] => [
  ...tokenize("وفقًا لهذا المستند، صُمّمت الدراسة وفق المنهج شبه التجريبي «بمجموعتين تجريبية وضابطة»."),
  "[DONE]",
];
