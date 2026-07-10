export default function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {/* Mark: a speech bubble holding two caption lines -- what gets said in
          a meeting turns into clear, kept text (subtitles, translation,
          transcript). That IS the product's promise: nothing gets lost. */}
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-soft">
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
          <path
            d="M4 8a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4h-5.2L7 20.4a1 1 0 0 1-1.6-.8V16.7A4 4 0 0 1 4 13V8Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <rect x="8" y="8.2" width="8.5" height="1.9" rx="0.95" fill="currentColor" />
          <rect x="8" y="11.6" width="5.5" height="1.9" rx="0.95" fill="currentColor" />
        </svg>
      </span>
      <span className="text-lg font-bold tracking-tight text-white">Unify</span>
    </div>
  );
}
