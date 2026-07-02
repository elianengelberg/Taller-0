import { useState } from "react";
import { useMeeting } from "../context/MeetingContext";
import { inputClass } from "../lib/ui";
import Button from "./Button";
import RoleBadge from "./RoleBadge";
import SidePanel from "./SidePanel";

export default function ParticipantsPanel({ onClose }: { onClose: () => void }) {
  const { meeting, isHost, self, assignRole, addRole } = useMeeting();
  const [newRole, setNewRole] = useState("");
  const [adding, setAdding] = useState(false);

  if (!meeting) return null;

  const participants = [...meeting.participants].sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
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

  return (
    <SidePanel title={`Participantes (${participants.length})`} onClose={onClose}>
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
          const isSelf = participant.id === self?.id;
          return (
            <li
              key={participant.id}
              className="flex flex-col gap-2 rounded-xl border border-ink-700 bg-ink-800/60 p-2.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink-700 text-xs font-bold text-white">
                  {participant.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">
                    {participant.name}
                    {isSelf ? " (vos)" : ""}
                    {participant.isHost ? " · Anfitrión" : ""}
                  </p>
                  <RoleBadge role={role} size="sm" />
                </div>
              </div>

              {isHost && (
                <select
                  className="w-full max-w-[140px] shrink-0 truncate rounded-lg border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-white focus:border-brand-400 focus:outline-none sm:w-auto"
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
            </li>
          );
        })}
      </ul>
    </SidePanel>
  );
}
