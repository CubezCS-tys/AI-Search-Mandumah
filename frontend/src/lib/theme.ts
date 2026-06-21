"use client";

import { useCallback, useEffect, useState } from "react";

// Central theme hook (PLAN-00b B5). Dark mode is a `.dark` class on <html>
// (applied pre-paint by the layout script from localStorage.theme), so there is
// no central programmatic toggle today. This gives features + the visual tests
// one place to read/flip it. Numbers stay dir="ltr" + tabular-nums elsewhere.
export type Theme = "light" | "dark";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>("light");

  // Sync to the actual class after hydration (avoids an SSR/CSR mismatch).
  useEffect(() => {
    setThemeState(currentTheme());
  }, []);

  const setTheme = useCallback((t: Theme) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    try {
      localStorage.setItem("theme", t);
    } catch {
      // ignore storage failures (private mode / disabled)
    }
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(currentTheme() === "dark" ? "light" : "dark");
  }, [setTheme]);

  return { theme, setTheme, toggle };
}
