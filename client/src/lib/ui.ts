// Shared visual primitives (design tokens applied). Everything resolves
// through the theme variables in index.css, so these look right in both
// light and dark mode without per-usage changes.
export const inputClass =
  "w-full rounded-xl border border-ink-600 bg-ink-950 px-4 py-3 text-ink-50 shadow-sm transition-colors duration-200 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30";

export const labelClass = "mb-1.5 block text-sm font-medium text-ink-200";

export const cardClass = "rounded-2xl border border-ink-700 bg-ink-800 p-6 shadow-soft sm:p-8";

// Mobile-keyboard hints per field type. Spread onto an <input>/<textarea> so
// on-screen keyboards behave sensibly (these are ignored on desktop). Getting
// them right is what makes the phone auto-capitalize a name or the first letter
// of a chat line -- and, just as important, what stops it from "helpfully"
// autocapitalizing/autocorrecting a URL or a meeting code and breaking it.

// Names: capitalize each word ("diego" -> "Diego"), no autocorrect underlines.
export const nameInputProps = { autoCapitalize: "words", autoCorrect: "off", spellCheck: false } as const;

// Free-form prose (chat, AI questions): capitalize the first letter of each
// sentence, keep autocorrect/spellcheck on like any normal message field.
export const sentenceInputProps = { autoCapitalize: "sentences", autoCorrect: "on", spellCheck: true } as const;

// Meeting join code: force the ALL-CAPS keyboard and turn OFF autocorrect (which
// would mangle a short code), autocomplete and spellcheck.
export const codeInputProps = {
  autoCapitalize: "characters",
  autoCorrect: "off",
  autoComplete: "off",
  spellCheck: false,
  inputMode: "text",
} as const;

// URLs (external meeting links): NEVER capitalize/autocorrect -- paths and room
// ids are case-sensitive, so a "helpful" capital letter breaks detection.
export const urlInputProps = {
  autoCapitalize: "none",
  autoCorrect: "off",
  autoComplete: "off",
  spellCheck: false,
  inputMode: "url",
} as const;

// Emails: never capitalize/autocorrect; show the email keyboard.
export const emailInputProps = {
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
  inputMode: "email",
} as const;

// Normalizes whatever the user types/pastes into the meeting-code field into a
// clean code: accepts a pasted full invite link (…/unirse/CODE), strips spaces
// and dashes people add, and uppercases -- so "abc 123", "ABC-123" and the full
// share link all resolve to the same "ABC123". Matching is case-insensitive
// server-side, but normalizing here means the field never LOOKS wrong.
export function normalizeMeetingCode(raw: string): string {
  const fromLink = raw.match(/\/unirse\/([^/?#\s]+)/i)?.[1];
  return (fromLink ?? raw).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}
