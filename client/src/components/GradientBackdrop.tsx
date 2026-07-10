// Soft, blurred brand-blue glows used behind auth/landing screens -- the
// "modern SaaS" backdrop. Pure CSS (no images), theme-aware via the brand
// tokens, and pointer-events-none so it never intercepts clicks.
export default function GradientBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-32 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-brand-500/15 blur-3xl" />
      <div className="absolute -left-24 top-1/3 h-80 w-80 rounded-full bg-brand-400/10 blur-3xl" />
      <div className="absolute -right-24 bottom-0 h-80 w-96 rounded-full bg-accent-teal/10 blur-3xl" />
    </div>
  );
}
