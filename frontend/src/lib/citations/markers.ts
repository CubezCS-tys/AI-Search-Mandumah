// Pure citation-marker helpers shared by the synthesis answer (numbered "(م N)"
// citations) and the chat answer («quoted» citations). Extracted from
// SynthesisPanel.tsx and ChatPanel.tsx so the parsing core (the part most likely
// to break on unusual Arabic input) is unit-testable in isolation.

/* Numbered citations: "(م N)" used in the synthesis answer. */

/** Replace "(م N)" with a markdown link so it can render as a clickable badge. */
export function addNumberedCitationLinks(text: string): string {
  return text.replace(/\(م\s*(\d+)\)/g, " [م$1](#cite-$1)");
}

/** The 1-based source numbers actually cited via "(م N)" markers in the answer. */
export function citedNumbers(text: string): Set<number> {
  const set = new Set<number>();
  for (const m of text.matchAll(/\(م\s*(\d+)\)/g)) set.add(parseInt(m[1], 10));
  return set;
}

/** Stable, unicode-safe id for a heading so the outline can scroll to it. */
export function slugify(s: string): string {
  return "syn-" + s.trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "");
}

/* Quoted citations: «...» used in the chat answer. */

const QUOTE_SPLIT_RE = /(«[^»]+»)/g;
const CONNECTOR_RE =
  /^\s*[،,]?\s*(?:و|أو|ثم|في|من|إلى|على|عن|مع|بين|بل|لا|لم|هو|هي|أن|إن|كان|كما|حيث|لكن)?\s*$/;

/** Split text into parts, isolating «quoted» spans as their own entries. */
export function splitQuotedCitations(text: string): string[] {
  return text.split(QUOTE_SPLIT_RE);
}

/** True if a part is a «...» quoted citation. */
export function isQuotedCitation(part: string): boolean {
  return part.startsWith("«") && part.endsWith("»");
}

/** Strip the surrounding guillemets from a «...» citation. */
export function unwrapCitation(part: string): string {
  return part.slice(1, -1);
}

/** Merge "«a» <short connector> «b»" into a single "«a connector b»" citation. */
export function mergeQuotedCitations(rawParts: string[]): string[] {
  const merged: string[] = [];
  for (let i = 0; i < rawParts.length; i++) {
    const isCit = isQuotedCitation(rawParts[i]);
    if (
      isCit &&
      merged.length >= 2 &&
      isQuotedCitation(merged[merged.length - 2])
    ) {
      const gap = merged[merged.length - 1];
      if (CONNECTOR_RE.test(gap) && gap.trim().length <= 5) {
        const prev = merged[merged.length - 2];
        merged.pop();
        merged.pop();
        const prevText = unwrapCitation(prev);
        const curText = unwrapCitation(rawParts[i]);
        merged.push("«" + prevText + gap + curText + "»");
        continue;
      }
    }
    merged.push(rawParts[i]);
  }
  return merged;
}
