import { ReactNode } from "react";
import { CloseIcon } from "./icons";

interface SidePanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  headerExtra?: ReactNode;
}

export default function SidePanel({ title, onClose, children, footer, headerExtra }: SidePanelProps) {
  return (
    <aside className="panel-enter flex h-full w-full flex-col border-l border-ink-700 bg-ink-900 sm:w-96">
      <div className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <div className="flex items-center gap-1">
          {headerExtra}
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar panel"
            className="rounded-full p-1.5 text-ink-300 hover:bg-ink-800"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      {footer && <div className="border-t border-ink-700 p-3">{footer}</div>}
    </aside>
  );
}
