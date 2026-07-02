import { Participant, Role } from "../types";
import ParticipantTile from "./ParticipantTile";

interface Props {
  participants: Participant[];
  roles: Role[];
  selfId: string | null;
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
}

export default function VideoGrid({ participants, roles, selfId, localStream, remoteStreams }: Props) {
  return (
    <div className={`grid gap-3 ${gridColumnsFor(participants.length)}`}>
      {participants.map((participant) => {
        const isSelf = participant.id === selfId;
        const stream = isSelf ? localStream : remoteStreams[participant.id] ?? null;
        const role = roles.find((r) => r.id === participant.roleId) ?? null;
        return (
          <ParticipantTile
            key={participant.id}
            participant={participant}
            role={role}
            stream={stream}
            isSelf={isSelf}
          />
        );
      })}
    </div>
  );
}

function gridColumnsFor(count: number): string {
  if (count <= 1) return "mx-auto max-w-2xl grid-cols-1";
  if (count === 2) return "grid-cols-1 sm:grid-cols-2";
  if (count <= 4) return "grid-cols-2";
  if (count <= 6) return "grid-cols-2 sm:grid-cols-3";
  return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
}
