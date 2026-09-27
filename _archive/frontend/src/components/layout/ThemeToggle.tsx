"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

/**
 * Light/dark theme toggle. The initial class is applied pre-paint by an inline
 * script in the root layout; this component syncs its icon to the live state
 * and persists the user's choice to localStorage.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(
      document.documentElement.classList.contains("dark") ? "dark" : "light",
    );
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* storage unavailable — choice just won't persist */
    }
    setTheme(next);
  };

  // Avoid rendering a mismatched icon before we know the resolved theme.
  if (theme === null) {
    return <span className="h-7 w-7" aria-hidden />;
  }

  const isDark = theme === "dark";

  return (
    <button
      onClick={toggle}
      aria-label={isDark ? "التبديل إلى الوضع الفاتح" : "التبديل إلى الوضع الداكن"}
      title={isDark ? "الوضع الفاتح" : "الوضع الداكن"}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-bg-elevated text-text-secondary transition hover:text-text-primary"
    >
      {isDark ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}
