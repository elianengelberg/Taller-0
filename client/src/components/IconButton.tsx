import { ReactNode } from "react";

interface IconButtonProps {
  label: string;
  active?: boolean;
  danger?: boolean;
  badge?: number;
  onClick?: () => void;
  children: ReactNode;
}

export default function IconButton({ label, active, danger, badge, onClick, children }: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`relative flex h-12 w-12 items-center justify-center rounded-full transition ${
        danger
          ? "bg-red-600 text-white hover:bg-red-700"
          : active
          ? "bg-brand-500 text-white hover:bg-brand-600"
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
  );
}
