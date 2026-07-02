export default function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500 text-white shadow-soft">
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
          <rect x="3" y="6" width="12" height="12" rx="3" fill="currentColor" />
          <path d="M17 10.2 21 8v8l-4-2.2Z" fill="currentColor" />
        </svg>
      </span>
      <span className="text-lg font-bold tracking-tight text-white">Encuentro</span>
    </div>
  );
}
