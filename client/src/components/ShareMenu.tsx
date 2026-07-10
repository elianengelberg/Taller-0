import { useEffect, useRef, useState } from "react";
import { meetingJoinUrl } from "../lib/share";
import { CopyIcon, LinkIcon, MailIcon, ShareIcon, WhatsAppIcon } from "./icons";

interface ShareMenuProps {
  meetingCode: string;
}

const menuItemClass =
  "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-ink-200 hover:bg-ink-700";

export default function ShareMenu({ meetingCode }: ShareMenuProps) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const joinUrl = meetingJoinUrl(meetingCode);
  const inviteText = `Te invito a una videollamada en Unify. Unite acá: ${joinUrl}\n\n(o entrá a ${window.location.origin} con el código ${meetingCode})`;

  // Closes on an outside click/tap or Escape -- the app's first popover-style
  // menu, so there's no existing pattern for this to reuse yet.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback(label);
      setTimeout(() => setFeedback(null), 1500);
    } catch {
      setFeedback(null);
    }
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-ink-600 px-3 py-2 text-sm font-medium text-ink-200 hover:border-brand-400"
        title="Invitar a la reunión"
        aria-expanded={open}
      >
        <ShareIcon className="h-4 w-4" />
        {feedback ?? meetingCode}
      </button>

      {open && (
        // Opens upward (bottom-full) since this button lives in the bottom
        // ControlBar -- opening downward would push the menu off-screen.
        <div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-ink-600 bg-ink-800 shadow-soft">
          <div className="border-b border-ink-700 px-3 py-2">
            <p className="text-xs font-medium text-ink-400">Invitar a la reunión</p>
            <p className="mt-0.5 truncate text-xs text-ink-500">{joinUrl}</p>
          </div>
          <button type="button" className={menuItemClass} onClick={() => copy(joinUrl, "¡Link copiado!")}>
            <LinkIcon className="h-4 w-4 shrink-0" />
            Copiar link de invitación
          </button>
          <button
            type="button"
            className={menuItemClass}
            onClick={() => copy(meetingCode, "¡Código copiado!")}
          >
            <CopyIcon className="h-4 w-4 shrink-0" />
            Copiar código ({meetingCode})
          </button>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(inviteText)}`}
            target="_blank"
            rel="noopener noreferrer"
            className={menuItemClass}
            onClick={() => setOpen(false)}
          >
            <WhatsAppIcon className="h-4 w-4 shrink-0" />
            Enviar por WhatsApp
          </a>
          <a
            href={`mailto:?subject=${encodeURIComponent("Invitación a una reunión en Unify")}&body=${encodeURIComponent(inviteText)}`}
            className={menuItemClass}
            onClick={() => setOpen(false)}
          >
            <MailIcon className="h-4 w-4 shrink-0" />
            Enviar por email
          </a>
        </div>
      )}
    </div>
  );
}
