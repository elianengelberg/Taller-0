// All swatches stay within the brand's orange / black / white family so
// role badges feel like one visual system while still being distinguishable
// by shade (the role name is always shown as text too, never color alone).
export const ROLE_COLOR_STYLES: { bg: string; text: string; dot: string }[] = [
  { bg: "bg-brand-500", text: "text-white", dot: "bg-white" },
  { bg: "bg-ink-800", text: "text-white", dot: "bg-brand-300" },
  { bg: "bg-brand-200", text: "text-ink-800", dot: "bg-brand-600" },
  { bg: "bg-brand-700", text: "text-white", dot: "bg-brand-200" },
  { bg: "bg-ink-500", text: "text-white", dot: "bg-brand-200" },
  { bg: "bg-brand-300", text: "text-ink-900", dot: "bg-ink-800" },
  { bg: "bg-ink-700", text: "text-brand-100", dot: "bg-brand-400" },
  { bg: "bg-brand-600", text: "text-white", dot: "bg-white" },
];

export function roleColorStyle(colorIndex: number) {
  return ROLE_COLOR_STYLES[((colorIndex % ROLE_COLOR_STYLES.length) + ROLE_COLOR_STYLES.length) % ROLE_COLOR_STYLES.length];
}
