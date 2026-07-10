// Shared visual primitives (design tokens applied). Everything resolves
// through the theme variables in index.css, so these look right in both
// light and dark mode without per-usage changes.
export const inputClass =
  "w-full rounded-xl border border-ink-600 bg-ink-950 px-4 py-3 text-ink-50 shadow-sm transition-colors duration-200 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30";

export const labelClass = "mb-1.5 block text-sm font-medium text-ink-200";

export const cardClass = "rounded-2xl border border-ink-700 bg-ink-800 p-6 shadow-soft sm:p-8";
