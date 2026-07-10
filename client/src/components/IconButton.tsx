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
        className={`relative flex h-12 w-12 items-center justify-center rounded-full shadow-soft ring-1 transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 ${
          danger
            ? "bg-gradient-to-b from-red-500 to-red-600 text-on-accent ring-red-400/30 shadow-red-600/30 hover:shadow-lg hover:shadow-red-600/35"
            : active
            ? "bg-gradient-to-b from-brand-500 to-brand-600 text-on-accent ring-brand-400/30 shadow-brand-600/30 hover:shadow-lg hover:shadow-brand-600/35"
            : "bg-ink-800 text-strong ring-ink-700 hover:ring-brand-400"
        }`}
      >
        {children}
        {typeof badge === "number" && badge > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-bold text-on-accent">
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
