import { useState } from "react";
import { useMeeting } from "../context/MeetingContext";
import { showToast } from "../lib/toasts";
import Button from "./Button";
import SidePanel from "./SidePanel";

// The host/co-host control center: room-wide switches (lock, waiting room,
// chat and screen-share policies), bulk actions, and the waiting-room queue.
// Every action here is re-validated server-side -- this panel is just the
// steering wheel (see the server's "moderate" handler).
export default function HostControlsPanel({
  onClose,
  side,
}: {
  onClose: () => void;
  side?: "left" | "right";
}) {
  const { meeting, self, waitingList, moderate } = useMeeting();
  const [confirmEnd, setConfirmEnd] = useState(false);
  if (!meeting || !self || self.moderationRole === "participant") return null;
  const settings = meeting.settings;
  const isHost = self.moderationRole === "host";

  async function run(action: string, targetId?: string, value?: unknown) {
    const res = await moderate(action, targetId, value);
    if (!res.ok && res.error) showToast({ text: res.error, kind: "warning" });
  }

  const rowClass = "flex items-center justify-between gap-3 rounded-xl border border-ink-700 bg-ink-800/60 p-3";
  const selectClass =
    "rounded-lg border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-strong focus:border-brand-400 focus:outline-none";

  return (
    <SidePanel title="Controles del anfitrión" onClose={onClose} side={side}>
      <div className="space-y-3">
        {waitingList.length > 0 && (
          <div className="rounded-xl border border-brand-500/50 bg-brand-500/10 p-3">
            <p className="text-xs font-semibold text-brand-300">
              Sala de espera ({waitingList.length})
            </p>
            <ul className="mt-2 space-y-2">
              {waitingList.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-strong">{w.name}</span>
                  <button
                    type="button"
                    onClick={() => run("admit", w.id)}
                    className="rounded-lg bg-brand-500 px-2.5 py-1 text-xs font-semibold text-on-accent hover:bg-brand-600"
                  >
                    Admitir
                  </button>
                  <button
                    type="button"
                    onClick={() => run("reject", w.id)}
                    className="rounded-lg border border-ink-600 px-2.5 py-1 text-xs font-medium text-ink-300 hover:border-red-400 hover:text-red-400"
                  >
                    Rechazar
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <label className={rowClass}>
          <span>
            <span className="block text-sm font-medium text-strong">Bloquear reunión</span>
            <span className="block text-xs text-ink-400">Nadie más puede entrar</span>
          </span>
          <input
            type="checkbox"
            className="h-4 w-4 accent-brand-500"
            checked={settings.locked}
            onChange={(e) => run("set-lock", undefined, e.target.checked)}
          />
        </label>

        <label className={rowClass}>
          <span>
            <span className="block text-sm font-medium text-strong">Sala de espera</span>
            <span className="block text-xs text-ink-400">Admitís a cada persona antes de entrar</span>
          </span>
          <input
            type="checkbox"
            className="h-4 w-4 accent-brand-500"
            checked={settings.waitingRoomEnabled}
            onChange={(e) => run("set-waiting-room", undefined, e.target.checked)}
          />
        </label>

        <div className={rowClass}>
          <span>
            <span className="block text-sm font-medium text-strong">Chat</span>
            <span className="block text-xs text-ink-400">Quién puede escribir y a quién</span>
          </span>
          <select
            aria-label="Modo de chat"
            className={selectClass}
            value={settings.chatMode}
            onChange={(e) => run("set-chat-mode", undefined, e.target.value)}
          >
            <option value="everyone">Todos</option>
            <option value="hosts">Solo con anfitriones</option>
            <option value="off">Desactivado</option>
          </select>
        </div>

        <div className={rowClass}>
          <span>
            <span className="block text-sm font-medium text-strong">Compartir pantalla</span>
            <span className="block text-xs text-ink-400">Quién puede presentar</span>
          </span>
          <select
            aria-label="Quién puede compartir pantalla"
            className={selectClass}
            value={settings.sharePolicy}
            onChange={(e) => run("set-share-policy", undefined, e.target.value)}
          >
            <option value="everyone">Todos</option>
            <option value="hosts">Solo anfitriones</option>
          </select>
        </div>

        <Button variant="secondary" className="w-full" onClick={() => run("mute-all")}>
          Silenciar a todos
        </Button>

        {isHost &&
          (confirmEnd ? (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3">
              <p className="text-sm text-red-500 dark:text-red-300">
                ¿Terminar la reunión para todos? No se puede deshacer.
              </p>
              <div className="mt-2 flex gap-2">
                <Button variant="danger" className="flex-1 py-2 text-xs" onClick={() => run("end-meeting")}>
                  Sí, finalizar
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1 py-2 text-xs"
                  onClick={() => setConfirmEnd(false)}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="danger" className="w-full" onClick={() => setConfirmEnd(true)}>
              Finalizar la reunión para todos
            </Button>
          ))}
      </div>
    </SidePanel>
  );
}
