interface LogoProps {
  className?: string;
  // Show the slogan under the wordmark (login/register hero placements).
  tagline?: boolean;
}

// The Unify mark: two overlapping speech bubbles (a conversation) with a "U"
// carved into the front one -- meetings where both sides understand each
// other. Front bubble in the brand blue, back bubble in sky blue.
export function LogoMark({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden>
      <path
        d="M40 18h34a12 12 0 0 1 12 12v22a12 12 0 0 1-12 12h-2v10.5a3 3 0 0 1-5 2.2L55 66.5A12 12 0 0 1 40 54V30a12 12 0 0 1 0-12Z"
        fill="#38BDF8"
      />
      <path
        d="M14 30a12 12 0 0 1 12-12h30a12 12 0 0 1 12 12v22a12 12 0 0 1-12 12H36L23 74.5a3 3 0 0 1-5-2.3V62.4A12 12 0 0 1 14 52V30Z"
        fill="url(#unify-front)"
      />
      <path
        d="M32 30v11a9 9 0 0 0 18 0V30"
        fill="none"
        stroke="white"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <defs>
        <linearGradient id="unify-front" x1="14" y1="18" x2="68" y2="76" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3B82F6" />
          <stop offset="1" stopColor="#1D4ED8" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default function Logo({ className = "", tagline = false }: LogoProps) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <div className="flex flex-col">
        <span className="text-lg font-extrabold uppercase leading-none tracking-wide text-strong">
          Unify
        </span>
        {tagline && (
          <span className="mt-1 text-[11px] font-medium tracking-wide text-brand-300">
            Reuniones sin barreras
          </span>
        )}
      </div>
    </div>
  );
}
