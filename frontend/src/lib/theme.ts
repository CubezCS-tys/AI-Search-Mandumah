"use client";

import { useCallback, useSyncExternalStore } from "react";

// Central theme hook (PLAN-00b B5). Dark mode is a `.dark` class on <html>
// (applied pre-paint by the layout script from localStorage.theme). Read it via
// useSyncExternalStore so it is SSR-safe and stays in sync across all consumers
// (setTheme dispatches a "themechange" event); avoids a setState-in-effect.
export type Theme = "light" | "dark";

const THEME_EVENT = "themechange";

function readTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, readTheme, (): Theme => "light");

  const setTheme = useCallback((t: Theme) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    try {
      localStorage.setItem("theme", t);
    } catch {
      // ignore storage failures (private mode / disabled)
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  const toggle = useCallback(() => {
    setTheme(readTheme() === "dark" ? "light" : "dark");
  }, [setTheme]);

  return { theme, setTheme, toggle };
}
