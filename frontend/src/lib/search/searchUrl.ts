// Single source of truth for the /search URL. The page's search/filter/synth/view
// handlers all build their next URL through here so a param can never be dropped
// from one path. lab and cards are mutually exclusive by construction (lab wins,
// mirroring the render priority labMode > cardsMode in page.tsx).
export type SearchUrlState = {
  q: string;
  mode: string;
  synth: string;
  hyde: boolean;
  journalId: string;
  section: string;
  docId: string;
  lab: boolean;
  cards: boolean;
};

export function buildSearchUrl(s: SearchUrlState): string {
  const params = new URLSearchParams({ q: s.q, mode: s.mode, synth: s.synth });
  if (s.hyde) params.set("hyde", "1");
  if (s.journalId) params.set("journal", s.journalId);
  if (s.section) params.set("section", s.section);
  if (s.docId) params.set("doc", s.docId);
  if (s.lab) params.set("lab", "1");
  else if (s.cards) params.set("cards", "1");
  return `/search?${params.toString()}`;
}
