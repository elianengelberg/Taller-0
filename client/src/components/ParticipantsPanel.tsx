import { useEffect, useRef, useState } from "react";
import { useMeeting } from "../context/MeetingContext";
import { showToast } from "../lib/toasts";
import { inputClass } from "../lib/ui";
import { Participant } from "../types";
import Button from "./Button";
import { HandIcon, MoreIcon } from "./icons";
import RoleBadge from "./RoleBadge";
import SidePanel from "./SidePanel";

const QUALITY_COLORS: Record<string, string> = {
  good: "bg-accent-green",
  fair: "bg-amber-400",
  poor: "bg-red-500",
};

const MODERATION_LABEL: Record<string, string | null> = {
  host: "Anfitrión",
  cohost: "Co-anfitrión",
  participant: null,
};

export default function ParticipantsPanel({
  onClose,
  side,
}: {
  onClose: () => void;
  side?: "left" | "right";
}) {
  const { meeting, isHost, self, assignRole, addRole, moderate } = useMeeting();
  const [newRole, setNewRole] = useState("");
  const [adding, setAdding] = useState(false);
  // Which participant's moderation menu is open (one at a time).
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuFor) return;
    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuFor(null);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuFor(null);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuFor]);

  if (!meeting || !self) return null;
  const amModerator = self.moderationRole !== "participant";
  const amHost = self.moderationRole === "host";

  // Host first, then anyone with their hand up (so the person running the
  // meeting sees who wants to speak at a glance), then everyone else by
  // join order.
  const participants = [...meeting.participants].sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    if (a.handRaised !== b.handRaised) return a.handRaised ? -1 : 1;
    return a.joinedAt - b.joinedAt;
  });

  async function handleAddRole() {
    const name = newRole.trim();
    if (!name) return;
    setAdding(true);
    const role = await addRole(name);
    setAdding(false);
    if (role) setNewRole("");
  }

  async function run(action: string, targetId: string, value?: unknown) {
    setMenuFor(null);
    const res = await moderate(action, targetId, value);
    if (!res.ok && res.error) showToast({ text: res.error, kind: "warning" });
  }

  // The moderation actions available against `p`, given my own rank.
  // (The server re-validates every one of these -- see "moderate".)
  function actionsFor(p: Participant): { label: string; action: string; danger?: boolean }[] {
    if (!amModerator || p.id === self!.id) return [];
    const targetIsModerator = p.moderationRole !== "participant";
    if (targetIsModerator && !amHost) return [];
    const actions: { label: string; action: string; danger?: boolean }[] = [];
    if (!targetIsModerator || amHost) {
      if (p.muted) actions.push({ label: "Pedir que active el micrófono", action: "request-unmute" });
      else actions.push({ label: "Silenciar", action: "mute" });
      if (p.cameraOff) actions.push({ label: "Pedir que prenda la cámara", action: "request-camera-on" });
      else actions.push({ label: "Pedir que apague la cámara", action: "request-camera-off" });
      if (p.handRaised) actions.push({ label: "Bajar la mano", action: "lower-hand" });
      if (p.sharingScreen) actions.push({ label: "Detener su pantalla", action: "stop-share" });
    }
    if (amHost) {
      if (p.moderationRole === "participant") actions.push({ label: "Hacer co-anfitrión", action: "make-cohost" });
      if (p.moderationRole === "cohost") actions.push({ label: "Quitar co-anfitrión", action: "remove-cohost" });
      actions.push({ label: "Transferir anfitrión", action: "transfer-host" });
    }
    if (!targetIsModerator) actions.push({ label: "Quitar de la reunión", action: "kick", danger: true });
    return actions;
  }

  return (
    <SidePanel title={`Participantes (${participants.length})`} onClose={onClose} side={side}>
      {isHost && (
        <div className="mb-4 rounded-xl border border-dashed border-brand-500/50 bg-brand-500/10 p-3">
          <p className="mb-2 text-xs font-medium text-brand-300">Agregar un rol nuevo</p>
          <div className="flex gap-2">
            <input
              className={`${inputClass} py-2 text-sm`}
              placeholder="Ej: Logística"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              maxLength={40}
              onKeyDown={(e) => e.key === "Enter" && handleAddRole()}
            />
            <Button
              type="button"
              variant="secondary"
              className="px-4 py-2 text-sm"
              onClick={handleAddRole}
              disabled={adding || !newRole.trim()}
            >
              Agregar
            </Button>
          </div>
        </div>
      )}

      <ul className="space-y-2">
        {participants.map((participant) => {
          const role = meeting.roles.find((r) => r.id === participant.roleId) ?? null;
          const isSelf = participant.id === self.id;
          const modLabel = MODERATION_LABEL[participant.moderationRole];
          const actions = actionsFor(participant);
          return (
            <li
              key={participant.id}
              className="rounded-xl border border-ink-700 bg-ink-800/60 p-2.5"
            >
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink-700 text-xs font-bold text-strong">
                  {participant.name.slice(0, 2).toUpperCase()}
                  {participant.connectionQuality && (
                    <span
                      title={`Conexión: ${participant.connectionQuality === "good" ? "buena" : participant.connectionQuality === "fair" ? "regular" : "mala"}`}
                      className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-ink-800 ${QUALITY_COLORS[participant.connectionQuality]}`}
                    />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-strong">
                    <span className="truncate">
                      {participant.name}
                      {isSelf ? " (vos)" : ""}
                    </span>
                    {modLabel && (
                      <span className="shrink-0 rounded-full bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand-300">
                        {modLabel}
                      </span>
                    )}
                    {participant.handRaised && (
                      <HandIcon className="h-4 w-4 shrink-0 animate-bounce text-amber-400" />
                    )}
                  </p>
                  <RoleBadge role={role} size="sm" />
                </div>

                {isHost && (
                  <select
                    aria-label={`Rol de ${participant.name}`}
                    className="w-full max-w-[120px] shrink-0 truncate rounded-lg border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-strong focus:border-brand-400 focus:outline-none sm:w-auto"
                    value={participant.roleId ?? ""}
                    onChange={(e) => assignRole(participant.id, e.target.value || null)}
                  >
                    <option value="">Sin rol</option>
                    {meeting.roles.map((r) => (
                      <option key={r.id} value={r.id} title={r.name}>
                        {r.name.length > 24 ? `${r.name.slice(0, 24)}…` : r.name}
                      </option>
                    ))}
                  </select>
                )}

                {actions.length > 0 && (
                  <div className="relative" ref={menuFor === participant.id ? menuRef : undefined}>
                    <button
                      type="button"
                      aria-label={`Acciones para ${participant.name}`}
                      aria-expanded={menuFor === participant.id}
                      onClick={() => setMenuFor(menuFor === participant.id ? null : participant.id)}
                      className="rounded-full p-1.5 text-ink-300 transition-colors duration-200 hover:bg-ink-700 hover:text-strong"
                    >
                      <MoreIcon className="h-4 w-4" />
                    </button>
                    {menuFor === participant.id && (
                      <div className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-xl border border-ink-600 bg-ink-800 py-1 shadow-soft">
                        {actions.map((a) => (
                          <button
                            key={a.action}
                            type="button"
                            onClick={() => run(a.action, participant.id)}
                            className={`block w-full px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-ink-700 ${
                              a.danger ? "text-red-500 dark:text-red-400" : "text-ink-100"
                            }`}
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </SidePanel>
  );
}
