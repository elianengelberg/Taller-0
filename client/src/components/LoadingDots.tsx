interface Props {
  className?: string;
  // Tailwind size/color utilities for each dot (defaults to a brand dot).
  dotClassName?: string;
}

// Three dots that pulse one after another (see .loading-dot in index.css) so a
// "Conectando…" screen visibly animates instead of looking frozen.
export default function LoadingDots({ className = "", dotClassName = "h-2.5 w-2.5 bg-brand-400" }: Props) {
  return (
    <span className={`inline-flex items-end gap-1.5 ${className}`} role="status" aria-label="Cargando">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`loading-dot inline-block rounded-full ${dotClassName}`}
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}
