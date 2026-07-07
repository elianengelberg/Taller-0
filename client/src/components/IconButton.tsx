import { ReactNode } from "react";

interface IconButtonProps {
  label: string;
  // Short word or two shown under the icon at all times, so people don't
  // have to guess (or hover) to find out what a button does -- the full
  // `label` still covers the tooltip/aria text with more detail.
  caption?: string;
  active?: boolean;
  danger?: boolean;
  badge?: number;
  onClick?: () => void;
  children: ReactNode;
}

export default function IconButton({
  label,
  caption,
  active,
  danger,
  badge,
  onClick,
  children,
}: IconButtonProps) {
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        title={label}
        className={`relative flex h-12 w-12 items-center justify-center rounded-full shadow-soft ring-1 ring-white/5 transition-all duration-150 hover:scale-105 active:scale-95 ${
          danger
            ? "bg-gradient-to-b from-red-500 to-red-600 text-white shadow-[0_4px_16px_-4px_rgba(220,38,38,0.5)] hover:from-red-500 hover:to-red-700"
            : active
            ? "bg-gradient-to-b from-brand-400 to-brand-500 text-white shadow-[0_4px_16px_-4px_rgba(217,119,87,0.5)] hover:from-brand-400 hover:to-brand-600"
            : "bg-ink-800 text-white hover:bg-ink-700"
        }`}
      >
        {children}
        {typeof badge === "number" && badge > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-brand-300 px-1 text-[10px] font-bold text-ink-900">
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </button>
      {caption && (
        <span
          className={`text-[10px] font-medium leading-none ${
            danger ? "text-red-400" : active ? "text-brand-300" : "text-ink-400"
          }`}
        >
          {caption}
        </span>
      )}
    </div>
  );
}
