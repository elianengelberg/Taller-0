/** @type {import('tailwindcss').Config} */
// Every color here resolves to a CSS variable defined in index.css, where
// each variable has a light-theme and a dark-theme value (see
// :root[data-theme="..."]). Components only ever use these token classes --
// switching theme is just flipping the variables, no component changes.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Brand blues (from the Unify logo). 400-900 are theme-constant;
        // 100-300 flip per theme because they're used as accent TEXT (they
        // must darken on light backgrounds to keep contrast).
        brand: {
          50: "rgb(var(--brand-50) / <alpha-value>)",
          100: "rgb(var(--brand-100) / <alpha-value>)",
          200: "rgb(var(--brand-200) / <alpha-value>)",
          300: "rgb(var(--brand-300) / <alpha-value>)",
          400: "#38BDF8",
          500: "#3B82F6",
          600: "#2563EB",
          700: "#1D4ED8",
          800: "#1E40AF",
          900: "#1E3A8A",
        },
        // Teal/green support accents (stats, success states).
        accent: {
          teal: "#14B8A6",
          green: "#22C55E",
        },
        // Neutral surface/text scale. Semantic, not literal: 950 is always
        // "page background" and 50 is always "strongest body text" -- in dark
        // mode that's navy->white, in light mode it inverts to white->navy.
        ink: {
          50: "rgb(var(--ink-50) / <alpha-value>)",
          100: "rgb(var(--ink-100) / <alpha-value>)",
          200: "rgb(var(--ink-200) / <alpha-value>)",
          300: "rgb(var(--ink-300) / <alpha-value>)",
          400: "rgb(var(--ink-400) / <alpha-value>)",
          500: "rgb(var(--ink-500) / <alpha-value>)",
          600: "rgb(var(--ink-600) / <alpha-value>)",
          700: "rgb(var(--ink-700) / <alpha-value>)",
          800: "rgb(var(--ink-800) / <alpha-value>)",
          900: "rgb(var(--ink-900) / <alpha-value>)",
          950: "rgb(var(--ink-950) / <alpha-value>)",
        },
        // "Primary text" -- white in dark mode, near-navy in light mode.
        strong: "rgb(var(--fg-strong) / <alpha-value>)",
        // Text sitting on a colored/gradient background (buttons, badges,
        // caption bubbles): always white, in BOTH themes.
        "on-accent": "#FFFFFF",
      },
      fontFamily: {
        // La display de los títulos y números protagonistas (misma que h1-h3
        // vía index.css); acá como clase para usarla fuera de encabezados.
        display: ["Sora", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
      },
      boxShadow: {
        soft: "var(--shadow-soft)",
        top: "var(--shadow-top)",
      },
    },
  },
  plugins: [],
};
