import { FormEvent, useEffect, useRef, useState } from "react";
import { useMeeting } from "../context/MeetingContext";
import { shortLang } from "../lib/languages";
import { translate } from "../lib/translate";
import { inputClass } from "../lib/ui";
import { GlobeIcon, SendIcon } from "./icons";
import RoleBadge from "./RoleBadge";
import SidePanel from "./SidePanel";

export default function ChatPanel({ onClose, side }: { onClose: () => void; side?: "left" | "right" }) {
  const { meeting, self, hostParticipant, sendChatMessage } = useMeeting();
  const [text, setText] = useState("");
  const [autoTranslate, setAutoTranslate] = useState(false);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  const chat = meeting?.chat ?? [];
  const hostLang = hostParticipant?.language ?? "es-AR";

  // Follow new entries only when the reader is already at (or near) the
  // bottom -- yanking someone to the bottom while they're scrolled up
  // reading older content loses their place. Opening the panel still lands
  // at the latest entry.
  const firstScrollRef = useRef(true);
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const container = el.closest(".overflow-y-auto");
    const nearBottom = container
      ? container.scrollHeight - container.scrollTop - container.clientHeight < 160
      : true;
    if (firstScrollRef.current || nearBottom) {
      el.scrollIntoView({ behavior: firstScrollRef.current ? "auto" : "smooth" });
    }
    firstScrollRef.current = false;
  }, [chat.length]);

  useEffect(() => {
    if (!autoTranslate) return;
    let cancelled = false;

    chat.forEach((message) => {
      if (translations[message.id]) return;
      if (shortLang(message.sourceLang) === shortLang(hostLang)) return;

      translate(message.text, message.sourceLang, hostLang)
        .then((translated) => {
          if (!cancelled) {
            setTranslations((prev) => ({ ...prev, [message.id]: translated }));
          }
        })
        .catch(() => {});
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTranslate, chat, hostLang]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    sendChatMessage(text);
    setText("");
  }

  return (
    <SidePanel
      title="Chat"
      onClose={onClose}
      side={side}
      headerExtra={
        <label className="flex items-center gap-1.5 pr-1 text-[11px] font-medium leading-tight text-ink-300">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-brand-500"
            checked={autoTranslate}
            onChange={(e) => setAutoTranslate(e.target.checked)}
          />
          Traducir al idioma
          <br />
          del anfitrión
        </label>
      }
      footer={
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <input
            className={`${inputClass} py-2.5 text-sm`}
            placeholder="Escribí un mensaje…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={2000}
          />
          <button
            type="submit"
            aria-label="Enviar mensaje"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white transition hover:bg-brand-600 disabled:opacity-50"
            disabled={!text.trim()}
          >
            <SendIcon className="h-4 w-4" />
          </button>
        </form>
      }
    >
      {chat.length === 0 ? (
        <p className="mt-6 text-center text-sm text-ink-400">
          Todavía no hay mensajes. ¡Escribí el primero!
        </p>
      ) : (
        <ul className="space-y-3">
          {chat.map((message) => {
            const role = meeting?.roles.find((r) => r.id === message.roleId) ?? null;
            const isSelf = message.senderId === self?.id;
            const translated = translations[message.id];
            return (
              <li key={message.id} className={`flex flex-col ${isSelf ? "items-end" : "items-start"}`}>
                <div className="flex items-center gap-1.5 text-xs text-ink-400">
                  <span className="font-semibold text-ink-100">
                    {isSelf ? "Vos" : message.senderName}
                  </span>
                  {role && <RoleBadge role={role} size="sm" />}
                </div>
                <div
                  className={`mt-1 max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${
                    isSelf ? "bg-brand-500 text-white" : "bg-ink-700 text-white"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{message.text}</p>
                  {translated && (
                    <p
                      className={`mt-1 flex items-start gap-1 whitespace-pre-wrap break-words border-t pt-1 text-xs italic ${
                        isSelf ? "border-white/30 text-white/80" : "border-ink-500/40 text-ink-300"
                      }`}
                    >
                      <GlobeIcon className="mt-0.5 h-3 w-3 shrink-0" />
                      {translated}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
          <div ref={bottomRef} />
        </ul>
      )}
    </SidePanel>
  );
}
