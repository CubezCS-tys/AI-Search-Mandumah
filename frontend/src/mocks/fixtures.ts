// Mock fixtures keyed to the REAL backend response shapes (types/search.ts,
// types/chat.ts, the admin Overview/Projection/Similar shapes). Search hits
// include the post-batch fields from PLAN-CORRECTIONS-v2 (score breakdown +
// plural-list MARC), which are null/absent on the real corpus until the backfill.
// Realistic Arabic content so the visual loop exercises RTL, mixed bidi, missing
// fields, and long titles.

export const SECTIONS = [
  "المقدمة",
  "الإطار النظري",
  "منهجية البحث",
  "النتائج",
  "المناقشة",
  "الخاتمة",
  "التوصيات",
];

interface MockHit {
  chunk_id: string;
  doc_id: string;
  text: string;
  title: string;
  section: string;
  score: number;
  chunk_index: number;
  journal_id: string;
  char_len: number;
  raw_score: number;
  lexical_score: number;
  title_score: number;
  authors: string[] | null;
  year: string | null;
  journal: string | null;
  keywords: string[] | null;
}

const HIT_SEED: Array<Partial<MockHit> & { title: string; section: string; score: number }> = [
  {
    title: "أثر التعلّم المقلوب في تنمية مهارات التفكير الناقد لدى طلاب المرحلة الثانوية",
    section: "النتائج",
    score: 0.842,
    raw_score: 0.0312,
    lexical_score: 0.71,
    title_score: 0.66,
    authors: ["أحمد بن سالم العتيبي", "نورة المطيري"],
    year: "1444",
    journal: "المجلة العربية للتربية",
    keywords: ["التعلّم المقلوب", "التفكير الناقد", "المرحلة الثانوية"],
  },
  {
    title: "فاعلية بيئات التعلّم الإلكترونية التشاركية في تحصيل الطلبة",
    section: "المناقشة",
    score: 0.788,
    raw_score: 0.0276,
    lexical_score: 0.62,
    title_score: 0.58,
    authors: ["خالد القحطاني"],
    year: "1443",
    journal: "مجلة تقنيات التعليم",
    keywords: ["التعلّم الإلكتروني", "التعلّم التشاركي"],
  },
  {
    title: "تطبيقات الذكاء الاصطناعي في تخصيص المسارات التعليمية",
    section: "الإطار النظري",
    score: 0.741,
    raw_score: 0.0241,
    lexical_score: 0.49,
    title_score: 0.72,
    authors: null, // a document missing MARC metadata (real corpus has these)
    year: null,
    journal: null,
    keywords: null,
  },
  {
    title: "صعوبات تعلّم القراءة لدى تلاميذ الصفوف الأولى وطرق علاجها",
    section: "منهجية البحث",
    score: 0.703,
    raw_score: 0.0219,
    lexical_score: 0.55,
    title_score: 0.41,
    authors: ["سارة الدوسري", "محمد بن عيسى"],
    year: "1441",
    journal: "مجلة اللسان العربي",
    keywords: ["صعوبات التعلّم", "القراءة"],
  },
  {
    title: "القيادة التحويلية وعلاقتها بالأداء المهني للمعلمين",
    section: "النتائج",
    score: 0.667,
    raw_score: 0.0188,
    lexical_score: 0.38,
    title_score: 0.52,
    authors: ["عبدالله الشهري"],
    year: "1445",
    journal: "مجلة الإدارة التربوية",
    keywords: ["القيادة التحويلية", "الأداء المهني"],
  },
];

export const searchFixture = {
  query: "التعلّم المقلوب والتفكير الناقد",
  mode: "hybrid",
  total: HIT_SEED.length,
  search_ms: 84,
  low_confidence: false,
  warning: null,
  suggestions: [],
  results: HIT_SEED.map((h, i) => ({
    chunk_id: "2048-014-003-0" + (20 + i) + "_chunk_00" + i,
    doc_id: "2048-014-003-0" + (20 + i),
    text:
      "يهدف هذا البحث إلى الكشف عن العلاقة بين المتغيّرات في ضوء " +
      h.title +
      "، معتمدًا على عيّنة من المجتمع الدراسي خلال الفصل الدراسي.",
    title: h.title,
    section: h.section,
    score: h.score,
    chunk_index: i,
    journal_id: "2048",
    char_len: 540 + i * 37,
    raw_score: h.raw_score ?? 0.02,
    lexical_score: h.lexical_score ?? 0.4,
    title_score: h.title_score ?? 0.4,
    authors: h.authors ?? null,
    year: h.year ?? null,
    journal: h.journal ?? null,
    keywords: h.keywords ?? null,
  })),
};

export const healthFixture = {
  status: "ok" as const,
  collection: "academic_articles_v2",
  points_count: 184523,
};

export const statsFixture = { chunks: 184523, documents: 12048 };

function gauss(seed: number): number {
  // deterministic pseudo-noise (no Math.random, so fixtures are stable)
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export const projectionFixture = {
  collection: "academic_articles_v2",
  color_by: "section",
  count: 240,
  explained_variance: [0.34, 0.19],
  points: Array.from({ length: 240 }, (_, i) => {
    const cluster = i % SECTIONS.length;
    return {
      x: Math.max(-1, Math.min(1, (cluster / 3 - 1) * 0.6 + gauss(i + 1) * 0.18)),
      y: Math.max(-1, Math.min(1, gauss(i + 100) * 0.7)),
      point_id: "pt_" + i,
      doc_id: "2048-014-003-0" + (i % 90),
      title: HIT_SEED[i % HIT_SEED.length].title,
      section: SECTIONS[cluster],
      chunk_index: i % 12,
      color_key: SECTIONS[cluster],
    };
  }),
};

export const similarFixture = {
  results: HIT_SEED.slice(1).map((h, i) => ({
    point_id: "pt_sim_" + i,
    score: 0.91 - i * 0.06,
    doc_id: "2048-014-003-0" + (30 + i),
    title: h.title,
    section: h.section,
    chunk_index: i,
    text: "مقطع قريب دلاليًا من المقطع المرجعي حول " + h.title + ".",
  })),
};
