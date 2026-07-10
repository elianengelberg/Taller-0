import { createContext, ReactNode, useContext, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "auto";

const KEY = "unify_theme";

function readStored(): ThemeMode {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "light" || raw === "dark" || raw === "auto" ? raw : "auto";
  } catch {
    return "auto";
  }
}

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(mode: ThemeMode): void {
  const resolved = mode === "auto" ? systemTheme() : mode;
  document.documentElement.dataset.theme = resolved;
  // Keep the browser chrome (mobile address bar) matching the page.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#0F172A" : "#F8FAFC");
}

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Owns the visual theme: "light" | "dark" | "auto" (follow the OS),
// persisted in localStorage so the choice survives reloads and sessions.
// The inline script in index.html applies the stored value before first
// paint (no flash); this provider takes over from there.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStored);

  useEffect(() => {
    apply(mode);
    if (mode !== "auto") return;
    // In auto mode, follow the OS live if the user switches their system theme.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("auto");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  function setMode(next: ThemeMode): void {
    setModeState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode -- preference just won't persist */
    }
  }

  return <ThemeContext.Provider value={{ mode, setMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme debe usarse dentro de ThemeProvider");
  return ctx;
}
