import { dismissToast, useToasts } from "../lib/toasts";
import { CloseIcon } from "./icons";

// Bottom-centered toast stack (above the control bar). Render once per page
// that needs notifications (meeting rooms); the store lives in lib/toasts.
export default function ToastViewport() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-28 z-40 flex flex-col items-center gap-2 px-4">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`pop-enter pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-soft backdrop-blur-md ${
            toast.kind === "warning"
              ? "border-amber-500/40 bg-ink-800/95 text-amber-600 dark:text-amber-300"
              : "border-ink-600 bg-ink-800/95 text-strong"
          }`}
        >
          <span className="min-w-0 flex-1">{toast.text}</span>
          {toast.actionLabel && toast.onAction && (
            <button
              type="button"
              onClick={() => {
                toast.onAction?.();
                dismissToast(toast.id);
              }}
              className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors duration-200 hover:bg-brand-600"
            >
              {toast.actionLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            aria-label="Cerrar aviso"
            className="shrink-0 rounded-full p-1 text-ink-400 hover:bg-ink-700"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
