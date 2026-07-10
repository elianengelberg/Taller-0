import { useEffect, useRef, useState } from "react";
import type {
  Call,
  CallAgent,
  LocalVideoStream,
  RemoteParticipant,
  RemoteVideoStream,
  VideoStreamRenderer,
} from "@azure/communication-calling";
import { fetchTeamsToken } from "../lib/api";
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from "./icons";

interface Props {
  // The full Teams meeting join URL (TeamsMeetingLinkLocator).
  meetingLink: string;
  displayName: string;
  onLeave?: () => void;
}

// Turns raw ACS/Teams errors into a clear Spanish message. The most common one
// is "Teams for life": ACS interop can only join Teams for WORK/SCHOOL
// meetings, never personal/free Teams meetings -- a Microsoft limitation.
function friendlyTeamsError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("teams for life") || lower.includes("teams for consumer")) {
    return "Esta es una reunión de Teams personal/gratuita, y Microsoft no permite unirse a ese tipo desde una app externa. Probá con una reunión de Teams de trabajo o escuela (cuenta Microsoft 365).";
  }
  if (lower.includes("invalid meeting link") || lower.includes("meeting link")) {
    return "El enlace de la reunión de Teams no es válido o expiró. Copiá de nuevo el enlace completo desde Teams.";
  }
  return raw ? `No se pudo unir a la reunión de Teams: ${raw}` : "No se pudo unir a la reunión de Teams.";
}

// Runs a real Microsoft Teams meeting embedded inside our layout via Azure
// Communication Services (ACS) "Teams interop" -- the official way to join an
// arbitrary Teams meeting by its link from a third-party web app (Teams has no
// Zoom-style Meeting SDK). Like Jitsi/Zoom, the meeting media lives here; our
// AI/transcription overlay (see ExternalMeeting) listens to the user's OWN
// microphone, so it works without reaching into the call internals.
//
// The ACS SDK is dynamically imported so its (large) bundle only loads when
// someone actually joins a Teams meeting, keeping it out of the main chunk.
export default function TeamsEmbed({ meetingLink, displayName, onLeave }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const localTileRef = useRef<HTMLDivElement>(null);
  // "companion" = personal/free Teams that can't be embedded: the real call
  // opens in its own tab and Unify's subtitle/transcript/AI layer (which
  // runs off the user's mic in ExternalMeeting) keeps working alongside it.
  const [status, setStatus] = useState<"connecting" | "joined" | "error" | "companion">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  // Live objects kept in refs for the control handlers + cleanup.
  const callRef = useRef<Call | null>(null);
  const agentRef = useRef<CallAgent | null>(null);
  const localVideoRef = useRef<LocalVideoStream | null>(null);
  const localRendererRef = useRef<VideoStreamRenderer | null>(null);
  const remoteRenderers = useRef<Map<RemoteVideoStream, { renderer: VideoStreamRenderer; tile: HTMLElement }>>(
    new Map()
  );

  useEffect(() => {
    let disposed = false;

    const syncRemoteFlag = () => {
      if (!disposed) setHasRemoteVideo(remoteRenderers.current.size > 0);
    };

    const t0 = Date.now();
    const log = (m: string) => console.log(`[TeamsEmbed +${Date.now() - t0}ms] ${m}`);

    async function start() {
      log("pidiendo token ACS");
      const { token, error: tokenError } = await fetchTeamsToken();
      if (disposed) return;
      if (!token) {
        setError(tokenError ?? "No se pudo autorizar el ingreso a Teams.");
        setStatus("error");
        return;
      }
      log("token OK, cargando SDK ACS");

      const sdk = await import("@azure/communication-calling");
      const { AzureCommunicationTokenCredential } = await import("@azure/communication-common");
      if (disposed) return;
      log("SDK cargado, creando callAgent");

      const callClient = new sdk.CallClient();
      const credential = new AzureCommunicationTokenCredential(token);
      const callAgent = await callClient.createCallAgent(credential, { displayName: displayName || "Invitado" });
      agentRef.current = callAgent;
      if (disposed) return;
      log("callAgent creado");

      // Best-effort local camera preview; join audio-only if it's unavailable
      // or the user denies permission.
      let localVideoStream: LocalVideoStream | undefined;
      try {
        const deviceManager = await callClient.getDeviceManager();
        await deviceManager.askDevicePermission({ audio: true, video: true });
        const cameras = await deviceManager.getCameras();
        if (!disposed && cameras[0]) {
          localVideoStream = new sdk.LocalVideoStream(cameras[0]);
          localVideoRef.current = localVideoStream;
          const renderer = new sdk.VideoStreamRenderer(localVideoStream);
          localRendererRef.current = renderer;
          const view = await renderer.createView({ scalingMode: "Crop" });
          if (!disposed && localTileRef.current) {
            view.target.style.width = "100%";
            view.target.style.height = "100%";
            localTileRef.current.appendChild(view.target);
          }
        }
      } catch {
        // No camera / permission denied -- continue with audio only.
      }
      if (disposed) return;

      log(`uniéndose a la reunión de Teams (video=${Boolean(localVideoStream)})`);
      const call = callAgent.join(
        { meetingLink },
        localVideoStream ? { videoOptions: { localVideoStreams: [localVideoStream] } } : undefined
      );
      callRef.current = call;

      call.on("stateChanged", () => {
        if (disposed) return;
        log(`call state: ${call.state}`);
        if (call.state === "Connected") setStatus("joined");
        else if (call.state === "Disconnected") {
          // callEndReason carries why (e.g. lobby rejection, invalid link).
          const reason = call.callEndReason;
          log(`disconnected reason code=${reason?.code} subCode=${reason?.subCode}`);
          onLeaveRef.current?.();
        }
      });

      const renderRemoteStream = async (stream: RemoteVideoStream) => {
        if (disposed || remoteRenderers.current.has(stream)) return;
        const renderer = new sdk.VideoStreamRenderer(stream);
        const view = await renderer.createView({ scalingMode: "Crop" });
        if (disposed) {
          renderer.dispose();
          return;
        }
        const tile = document.createElement("div");
        tile.className = "relative min-h-[120px] flex-1 basis-64 overflow-hidden rounded-lg bg-ink-900";
        view.target.style.width = "100%";
        view.target.style.height = "100%";
        tile.appendChild(view.target);
        gridRef.current?.appendChild(tile);
        remoteRenderers.current.set(stream, { renderer, tile });
        syncRemoteFlag();
      };

      const unrenderRemoteStream = (stream: RemoteVideoStream) => {
        const entry = remoteRenderers.current.get(stream);
        if (!entry) return;
        try {
          entry.renderer.dispose();
        } catch {
          /* already gone */
        }
        entry.tile.remove();
        remoteRenderers.current.delete(stream);
        syncRemoteFlag();
      };

      const subscribeStream = (stream: RemoteVideoStream) => {
        if (stream.isAvailable) void renderRemoteStream(stream);
        stream.on("isAvailableChanged", () => {
          if (stream.isAvailable) void renderRemoteStream(stream);
          else unrenderRemoteStream(stream);
        });
      };

      const subscribeParticipant = (participant: RemoteParticipant) => {
        participant.videoStreams.forEach(subscribeStream);
        participant.on("videoStreamsUpdated", (e) => {
          e.added.forEach(subscribeStream);
          e.removed.forEach(unrenderRemoteStream);
        });
      };

      call.remoteParticipants.forEach(subscribeParticipant);
      call.on("remoteParticipantsUpdated", (e) => {
        e.added.forEach(subscribeParticipant);
      });
    }

    start().catch((e: unknown) => {
      console.error("[TeamsEmbed] fatal", e);
      if (disposed) return;
      const raw =
        e && typeof e === "object" && "message" in e && typeof (e as { message?: unknown }).message === "string"
          ? (e as { message: string }).message
          : "";
      // Personal/free Teams can't be embedded (Microsoft blocks it), but our
      // subtitle/transcript/AI layer still works off the mic -- fall back to
      // "companion mode": open the real call in its own tab, keep Unify here.
      if (raw.toLowerCase().includes("teams for life") || raw.toLowerCase().includes("teams for consumer")) {
        setStatus("companion");
        return;
      }
      setError(friendlyTeamsError(raw));
      setStatus("error");
    });

    return () => {
      disposed = true;
      remoteRenderers.current.forEach(({ renderer, tile }) => {
        try {
          renderer.dispose();
        } catch {
          /* noop */
        }
        tile.remove();
      });
      remoteRenderers.current.clear();
      try {
        localRendererRef.current?.dispose();
      } catch {
        /* noop */
      }
      try {
        callRef.current?.hangUp();
      } catch {
        /* noop */
      }
      try {
        void agentRef.current?.dispose();
      } catch {
        /* noop */
      }
    };
  }, [meetingLink, displayName]);

  async function toggleMic() {
    const call = callRef.current;
    if (!call) return;
    try {
      if (call.isMuted) {
        await call.unmute();
        setMicOn(true);
      } else {
        await call.mute();
        setMicOn(false);
      }
    } catch {
      /* ignore transient mute errors */
    }
  }

  async function toggleCam() {
    const call = callRef.current;
    const lvs = localVideoRef.current;
    if (!call || !lvs) return;
    try {
      if (camOn) {
        await call.stopVideo(lvs);
        setCamOn(false);
      } else {
        await call.startVideo(lvs);
        setCamOn(true);
      }
    } catch {
      /* ignore transient video errors */
    }
  }

  if (status === "companion") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-md text-sm text-ink-200">
          Esta reunión de Teams es <span className="text-strong">personal/gratuita</span> y Microsoft no
          permite embeberla. Abrila en Teams en otra pestaña — los{" "}
          <span className="text-strong">subtítulos, la transcripción y la IA de Unify</span> siguen
          funcionando acá con tu micrófono.
        </p>
        <a
          href={meetingLink}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-on-accent hover:bg-brand-600"
        >
          Abrir la reunión en Teams
        </a>
        <p className="max-w-md text-xs text-ink-500">
          Dejá esta pestaña abierta al lado de Teams para ver los subtítulos y usar el asistente de IA.
        </p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="max-w-sm text-sm text-brand-300">{error}</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-ink-950">
      <div ref={gridRef} className="flex h-full w-full flex-wrap content-center items-center justify-center gap-2 p-2" />

      {!hasRemoteVideo && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
          <p className="text-sm text-ink-300">
            {status === "connecting" ? "Conectando con Teams…" : "Esperando a los demás participantes…"}
          </p>
        </div>
      )}

      {/* Local camera preview */}
      <div
        ref={localTileRef}
        className="absolute bottom-20 right-4 h-28 w-40 overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-lg sm:bottom-4"
      />

      {/* Meeting media controls (ACS raw SDK has no UI of its own) */}
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3">
        <button
          type="button"
          onClick={toggleMic}
          aria-label={micOn ? "Silenciar micrófono" : "Activar micrófono"}
          className={`flex h-11 w-11 items-center justify-center rounded-full ${
            micOn ? "bg-ink-800 text-strong hover:bg-ink-700" : "bg-brand-500 text-on-accent hover:bg-brand-600"
          }`}
        >
          {micOn ? <MicIcon className="h-5 w-5" /> : <MicOffIcon className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={toggleCam}
          aria-label={camOn ? "Apagar cámara" : "Encender cámara"}
          className={`flex h-11 w-11 items-center justify-center rounded-full ${
            camOn ? "bg-ink-800 text-strong hover:bg-ink-700" : "bg-brand-500 text-on-accent hover:bg-brand-600"
          }`}
        >
          {camOn ? <CameraIcon className="h-5 w-5" /> : <CameraOffIcon className="h-5 w-5" />}
        </button>
      </div>
    </div>
  );
}
