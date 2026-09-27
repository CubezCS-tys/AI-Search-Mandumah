"use client";

import { Fragment, useMemo, type ReactNode } from "react";

interface HighlightTextProps {
  /** The text to render with query terms highlighted. */
  text: string;
  /** The raw search query — split into terms by whitespace. */
  query?: string;
  /** Optional class applied to the wrapping span. */
  className?: string;
}

/** Escape regex special characters so query terms match literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Highlights case-insensitive substring matches of the query terms inside `text`.
 *
 * Arabic-safe: uses a plain case-insensitive substring match (no `\b` word
 * boundaries, which behave poorly with Arabic script). Terms shorter than 2
 * characters are ignored, and regex special characters are escaped.
 */
export default function HighlightText({ text, query = "", className }: HighlightTextProps) {
  const nodes = useMemo<ReactNode[]>(() => {
    const terms = query
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .map(escapeRegExp);

    if (terms.length === 0) return [text];

    const regex = new RegExp(`(${terms.join("|")})`, "gi");
    const parts = text.split(regex);

    return parts.map((part, i) => {
      // Odd-indexed parts are the captured matches.
      if (i % 2 === 1) {
        return (
          <mark
            key={i}
            className="rounded bg-amber-100 px-0.5 text-inherit"
          >
            {part}
          </mark>
        );
      }
      return <Fragment key={i}>{part}</Fragment>;
    });
  }, [text, query]);

  return <span className={className}>{nodes}</span>;
}
