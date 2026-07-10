import { ReactNode } from "react";
import { CloseIcon } from "./icons";

interface SidePanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  headerExtra?: ReactNode;
  // Which side this panel is docked on (desktop). Controls the divider border
  // so a left panel borders on its right and a right panel on its left. Two
  // panels can be open at once (see Meeting), one on each side.
  side?: "left" | "right";
}

export default function SidePanel({ title, onClose, children, footer, headerExtra, side = "right" }: SidePanelProps) {
  // On phones the panel overlays the whole meeting area (absolute inset-0) so
  // it can't get squeezed to a sliver or clipped by the row's overflow. From
  // sm up it's a normal flex column beside the video: shrink-0 keeps its full
  // width and z-10 keeps it painted above the video so no tile overlaps it.
  const border = side === "left" ? "border-r" : "border-l";
  return (
    <aside className={`panel-enter absolute inset-0 z-20 flex h-full w-full flex-col border-ink-800 bg-ink-900 shadow-2xl sm:static sm:z-10 sm:w-96 sm:shrink-0 ${border}`}>
      {/* Title + close button are their own row so the close button always
          stays reachable -- previously `headerExtra` (a language dropdown
          with a long label) shared the row with it and, on a narrow phone
          screen, pushed the close button past the edge of the panel with no
          way to see or tap it. `headerExtra` gets its own row below instead
          of fighting the title for space. */}
      <div className="border-b border-ink-700 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-strong">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar panel"
            className="shrink-0 rounded-full p-1.5 text-ink-300 hover:bg-ink-800"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        {headerExtra && <div className="mt-2">{headerExtra}</div>}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      {footer && <div className="border-t border-ink-700 p-3">{footer}</div>}
    </aside>
  );
}
