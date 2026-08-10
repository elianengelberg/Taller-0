import { ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import AiChatBox from "../components/AiChatBox";
import IconButton from "../components/IconButton";
import JitsiEmbed from "../components/JitsiEmbed";
import LiveCaption from "../components/LiveCaption";
import CompanionDock from "../components/CompanionDock";
import CompanionRolesPanel from "../components/CompanionRolesPanel";
import CompanionSubtitleStage from "../components/CompanionSubtitleStage";
import ExternalCompanionPane from "../components/ExternalCompanionPane";
import MeetCompanionPane from "../components/MeetCompanionPane";
import Logo from "../components/Logo";
import RecordingBanner from "../components/RecordingBanner";
import SaveMeetingPrompt from "../components/SaveMeetingPrompt";
import SidePanel from "../components/SidePanel";
import TeamsEmbed from "../components/TeamsEmbed";
import TranscriptPanel from "../components/TranscriptPanel";
import ZoomEmbed from "../components/ZoomEmbed";
import {
  CaptionsIcon,
  PeopleIcon,
  ShieldIcon,
  PhoneOffIcon,
  RecordIcon,
  SparklesIcon,
  StopIcon,
  TranscriptIcon,
} from "../components/icons";
import { useAuth } from "../context/AuthContext";
import { useMeeting } from "../context/MeetingContext";
import { AUTO_LANG, ORIGINAL_LANG, useLineTranslations } from "../hooks/useLineTranslations";
import { useRecorder } from "../hooks/useRecorder";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { askMeetingAI } from "../lib/api";
import { LANGUAGES, shortLang } from "../lib/languages";
import { recentCaptionEntries } from "../lib/captionLines";
import { screenCaptureSupported } from "../lib/screenCapture";
import { autoRecordEnabled, discardStashedDisplayStream, takeDisplayStream } from "../lib/autoRecord";
import { loadRoles, roleById, RoleMap, saveRoles } from "../lib/companionRoles";
import { setUnsavedMeeting } from "../lib/unsavedMeeting";
import { CompanionEmbed } from "../types";

type PanelKey = "transcript" | "ai" | "roles" | null;

// Renders the actual external-meeting pane for a companion session. One branch
// per embeddable platform; adding a new platform means adding a case here.
function CompanionEmbedPane({
  embed,
  displayName,
  onLeave,
  onDegrade,
  subtitleStage,
}: {
  embed: CompanionEmbed;
  displayName: string;
  onLeave: () => void;
  /**
   * El SDK de la plataforma no pudo abrir la llamada acá dentro. Nunca es un
   * callejón sin salida: la capa de Unify (subtítulos, traducción, IA,
   * grabación) no depende de ese SDK, así que se sigue en modo companion con
   * la llamada abierta en su propia pestaña.
   */
  onDegrade: (label: string, joinLink: string) => void;
  subtitleStage?: ReactNode;
}) {
  switch (embed.kind) {
    case "jitsi":
      return (
        <JitsiEmbed
          roomName={embed.roomName}
          displayName={displayName}
          onLeave={onLeave}
          onFailure={() => onDegrade("Jitsi", `https://meet.jit.si/${embed.roomName}`)}
        />
      );
    case "zoom":
      return (
        <ZoomEmbed
          meetingNumber={embed.meetingNumber}
          passcode={embed.passcode}
          displayName={displayName}
          onLeave={onLeave}
          onFailure={() => onDegrade("Zoom", `https://zoom.us/j/${embed.meetingNumber}`)}
        />
      );
    case "teams":
      return (
        <TeamsEmbed
          meetingLink={embed.meetingLink}
          displayName={displayName}
          onLeave={onLeave}
          onFailure={() => onDegrade("Teams", embed.meetingLink)}
        />
      );
    case "meet":
      return (
        <MeetCompanionPane
          meetLink={embed.meetLink}
          meetCode={embed.meetCode}
          subtitleStage={subtitleStage}
        />
      );
    case "external":
      return (
        <ExternalCompanionPane
          label={embed.label}
          joinLink={embed.joinLink}
          subtitleStage={subtitleStage}
        />
      );
  }
}

// The Unify layer that runs ON TOP of an external meeting (Jitsi, Zoom,
// Teams...). The external platform handles audio/video (the embedded pane, with
// its own mic/camera/share controls); we add a fixed Unify toolbar with our
// live subtitles, transcript, translation, AI assistant and recording. The
// trick that makes this possible without reaching inside the cross-origin
// embed: our transcription listens to the user's OWN microphone (Web Speech
// API) and syncs everyone's captions through our backend keyed by the shared
// external-room key (see join-companion).
export default function ExternalMeeting() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    draft,
    connectionStatus,
    connectionError,
    connect,
    meeting,
    self,
    sendTranscriptLine,
    setSelfLanguage,
    leaveMeeting,
  } = useMeeting();

  const [activePanel, setActivePanel] = useState<PanelKey>(null);
  // Cuando el SDK de la plataforma no puede abrir la llamada acá dentro,
  // caemos a companion en vez de dejar la pantalla muerta: los subtítulos, la
  // traducción, la IA y la grabación no dependen de ese SDK.
  const [degraded, setDegraded] = useState<CompanionEmbed | null>(null);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [interimCaption, setInterimCaption] = useState<string | null>(null);
  const [targetLangChoice, setTargetLangChoice] = useState<string>(AUTO_LANG);
  // Etiquetas locales por persona (ver lib/companionRoles): una sala companion
  // no tiene anfitrión que reparta roles, así que cada quien rotula como ve.
  const roomKey = draft?.mode === "companion" ? draft.externalKey : "";
  const [roles, setRoles] = useState<RoleMap>(() => (roomKey ? loadRoles(roomKey) : {}));
  function setRole(name: string, roleId: string) {
    setRoles((prev) => {
      const next = { ...prev, [name]: roleId };
      if (roomKey) saveRoles(roomKey, next);
      return next;
    });
  }
  // Foto de quien habla. Primero por id de participante; si ya se fue de la
  // sala, por nombre (la línea de transcripción sobrevive a quien la dijo).
  const avatarFor = (speakerId: string, speakerName: string) => {
    const people = meeting?.participants ?? [];
    const byId = people.find((p) => p.id === speakerId);
    if (byId) return byId.avatarUrl;
    return people.find((p) => p.name === speakerName)?.avatarUrl ?? null;
  };
  const roleFor = (name: string) => {
    const r = roleById(roles[name]);
    return r.id ? { label: r.label, color: r.color } : null;
  };

  const spokenLang = self?.language ?? (draft?.mode === "companion" ? draft.language : "es-AR");
  const targetLang = targetLangChoice === AUTO_LANG ? spokenLang : targetLangChoice;

  // No companion draft (e.g. someone refreshed this URL directly) -> there's
  // nothing to connect to; send them back to paste a link.
  useEffect(() => {
    if (!draft || draft.mode !== "companion") {
      navigate("/externa", { replace: true });
      return;
    }
    if (connectionStatus === "idle") connect();
  }, [draft, connectionStatus, connect, navigate]);

  // Same as the native meeting: leave cleanly on any navigation-away so the
  // server drops us from the companion room instead of keeping a ghost.
  useEffect(() => {
    function handlePageHide() {
      leaveMeeting();
    }
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      leaveMeeting();
    };
  }, [leaveMeeting]);

  useEffect(() => {
    if (!captionsOn) setInterimCaption(null);
  }, [captionsOn]);

  // Puntero de rescate para invitados, escrito EN CUANTO la reunión existe --
  // no al salir. Cerrar la pestaña por accidente (o que se muera la batería)
  // dejaba la reunión sin dueño y sin forma de reclamarla: el id se perdía con
  // la pestaña. Ahora, al crear una cuenta después, sigue estando.
  useEffect(() => {
    if (user || !meeting?.dbId) return;
    setUnsavedMeeting({ dbId: meeting.dbId, joinCode: meeting.id ?? "", endedAt: Date.now() });
  }, [user, meeting?.dbId, meeting?.id]);

  // Our own microphone, transcribed in the browser -- independent of the
  // external platform's own audio (which lives in an embed we can't touch).
  //
  // `micAttempt` es el botón de reintento: cuando el navegador deniega el
  // micrófono, el reconocimiento se apaga para siempre (ver el hook) y sin esto
  // no había forma de volver a encenderlo salvo recargando la página.
  const [micAttempt, setMicAttempt] = useState(0);
  const { supported: captionsSupported, error: captionsError } = useSpeechRecognition({
    key: micAttempt,
    lang: spokenLang,
    active: connectionStatus === "connected",
    onInterim: (text) => setInterimCaption(text),
    onResult: (alternatives) => {
      setInterimCaption(null);
      sendTranscriptLine(alternatives, spokenLang);
    },
  });
  // Sin esto, un navegador sin reconocimiento de voz (Firefox, Safari de
  // escritorio) o un micrófono denegado dejaban la pantalla diciendo
  // "Escuchando tu micrófono" para siempre, sin una sola línea y sin explicar
  // nada -- que es exactamente lo que se ve como "no andan los subtítulos".
  const captionsProblem = !captionsSupported
    ? "Este navegador no puede transcribir voz. Para ver subtítulos, entrá desde Chrome o Edge (en iPhone/iPad, desde la app de Chrome)."
    : captionsError;

  const { getTranslation, translationFailed } = useLineTranslations(meeting?.transcript ?? [], targetLang);

  // Records the whole tab (the embedded meeting + captions) with its audio.
  // No local mic stream here -- the external platform owns the mic -- but
  // getDisplayMedia with "share tab audio" captures the meeting's audio.
  const recorder = useRecorder({ micStream: null, meetingDbId: meeting?.dbId ?? null });
  function toggleRecording() {
    if (recorder.status === "recording") recorder.stop();
    else if (recorder.status === "idle" || recorder.status === "error") void recorder.start();
  }

  // --- Grabación automática -------------------------------------------------
  // En una reunión externa la grabación no se pide: arranca sola. Con la
  // captura de pantalla que se consiguió durante el clic de "Unirme" graba
  // video+audio; sin ella (URL directa, recarga, o cancelaron el selector)
  // graba el audio, que no necesita ningún gesto del usuario. En los dos
  // casos, sin que nadie apriete nada.
  const autoStartedRef = useRef(false);
  const startRef = useRef(recorder.start);
  startRef.current = recorder.start;
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (connectionStatus !== "connected" || !meeting?.dbId) return;
    autoStartedRef.current = true;
    if (!autoRecordEnabled()) {
      discardStashedDisplayStream();
      return;
    }
    const stream = takeDisplayStream();
    void startRef.current(stream ? { stream } : { audioOnly: true });
  }, [connectionStatus, meeting?.dbId]);

  // Si la persona apaga la grabación automática antes de entrar, la captura
  // que hubiera quedado colgada no se deja abierta.
  useEffect(() => () => discardStashedDisplayStream(), []);

  // One-shot flag left by the from-Meet deep link (extension button):
  // surface a "ready to record" hint until they start (or dismiss it).
  const [recHint, setRecHint] = useState(() => sessionStorage.getItem("unify_autorec") === "1");
  useEffect(() => {
    sessionStorage.removeItem("unify_autorec");
  }, []);
  const showRecHint = recHint && recorder.status === "idle";

  function togglePanel(panel: Exclude<PanelKey, null>) {
    setActivePanel((current) => (current === panel ? null : panel));
  }

  // Same guest-save prompt as the native meeting -- see Meeting.tsx.
  const [pendingLeave, setPendingLeave] = useState<string | null>(null);
  // While a recording is still being captured or uploaded, don't yank the user
  // out -- finish saving it first, so it reliably lands in the history instead
  // of the upload being abandoned mid-flight when they leave.
  const [savingRecording, setSavingRecording] = useState(false);
  const leftRef = useRef(false);
  // What to run once the recording is safely stored (each exit path differs:
  // plain leave, "save to an account", or "skip").
  const pendingExitRef = useRef<(() => void) | null>(null);

  // Runs `exit` now, or defers it until the recording finishes uploading.
  function exitWhenSaved(exit: () => void) {
    const busy =
      recorder.status === "recording" ||
      recorder.status === "processing" ||
      recorder.uploadStatus === "uploading";
    if (!busy) {
      exit();
      return;
    }
    if (recorder.status === "recording") recorder.stop();
    pendingExitRef.current = exit;
    setSavingRecording(true);
  }

  // Completes the deferred exit once the recording is uploaded (or after a 30s
  // fallback, so a stuck upload can never trap someone in the meeting).
  useEffect(() => {
    if (!savingRecording || leftRef.current) return;
    const finish = () => {
      if (leftRef.current) return;
      leftRef.current = true;
      const exit = pendingExitRef.current;
      pendingExitRef.current = null;
      exit?.();
    };
    const busy =
      recorder.status === "recording" ||
      recorder.status === "processing" ||
      recorder.uploadStatus === "uploading";
    if (!busy) {
      finish();
      return;
    }
    const t = setTimeout(finish, 30000);
    return () => clearTimeout(t);
  }, [savingRecording, recorder.status, recorder.uploadStatus]);

  function handleLeave() {
    if (!user && meeting?.dbId) {
      setPendingLeave(meeting.dbId);
      return;
    }
    exitWhenSaved(() => {
      leaveMeeting();
      navigate("/", { replace: true });
    });
  }
  function confirmSaveMeeting() {
    const dbId = pendingLeave!;
    setPendingLeave(null);
    exitWhenSaved(() => {
      leaveMeeting();
      navigate("/ingresar", { state: { claimMeetingId: dbId }, replace: true });
    });
  }
  function skipSaveMeeting() {
    const dbId = pendingLeave!;
    const joinCode = meeting?.id ?? "";
    setPendingLeave(null);
    exitWhenSaved(() => {
      setUnsavedMeeting({ dbId, joinCode, endedAt: Date.now() });
      leaveMeeting();
      navigate("/", { replace: true });
    });
  }

  if (!draft || draft.mode !== "companion") return null;

  const captionLines = captionsOn
    ? recentCaptionEntries(meeting?.transcript ?? [], getTranslation)
    : [];
  const participantCount = meeting?.participants.length ?? 0;
  // Últimas frases con su traducción, para la pantalla grande de subtítulos.
  const stageLines = (meeting?.transcript ?? []).slice(-8).map((l) => ({
    id: l.id,
    speakerId: l.speakerId,
    speakerName: l.speakerName,
    text: l.text,
    translated: getTranslation(l.id),
  }));
  const targetLabel =
    targetLangChoice === ORIGINAL_LANG
      ? null
      : (LANGUAGES.find((l) => shortLang(l.code) === shortLang(targetLang))?.label ?? null);
  // Enlace para que los demás abran ESTA reunión en Unify. Es la única forma de
  // sumar sus voces: cada navegador solo escucha su propio micrófono.
  const inviteUrl = (() => {
    if (draft?.mode !== "companion") return window.location.origin;
    const e = draft.embed;
    const link =
      e.kind === "meet"
        ? e.meetLink
        : e.kind === "teams"
          ? e.meetingLink
          : e.kind === "jitsi"
            ? `https://meet.jit.si/${e.roomName}`
            : e.kind === "external"
              ? e.joinLink
              : `https://zoom.us/j/${e.meetingNumber}`;
    return `${window.location.origin}/externa?link=${encodeURIComponent(link)}`;
  })();
  // Gente a la que se le puede poner rol: quienes hablaron + quienes están en la sala.
  const people = Array.from(
    new Set([
      ...(meeting?.transcript ?? []).map((l) => l.speakerName),
      ...(meeting?.participants ?? []).map((p) => p.name),
    ])
  );
  const recording = recorder.status === "recording";

  return (
    <div className="flex h-dvh flex-col bg-ink-950">
      {/* Minimal top bar: brand + which meeting we're on + who's here. All the
          actions live in the fixed toolbar at the bottom (like Zoom / our own
          meeting), so nothing floats around. */}
      {/* Barra mínima: identidad y de qué reunión se trata. El estado, el idioma
          y la invitación viven en el dock flotante sobre el video (ver el
          diseño), no acá. */}
      <header className="flex items-center justify-between gap-2 border-b border-ink-800 bg-ink-900/95 px-4 py-2.5 shadow-soft backdrop-blur-md sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          <span className="hidden truncate text-xs text-ink-400 sm:inline">{draft.roomLabel}</span>
        </div>
      </header>

      {showRecHint && (
        <div className="flex items-center justify-center gap-3 border-b border-brand-500/30 bg-brand-500/10 px-4 py-2 text-xs text-brand-300">
          <span>
            Listo para grabar: tocá <span className="font-semibold">Grabar</span> y elegí la
            pestaña de Meet con la casilla de audio tildada.
          </span>
          <button
            type="button"
            onClick={() => setRecHint(false)}
            aria-label="Cerrar aviso de grabación"
            className="rounded-full px-1.5 py-0.5 hover:bg-brand-500/20"
          >
            ✕
          </button>
        </div>
      )}

      {/* flex (not just relative) so the transcript/AI panel becomes a real
          column beside the embed on desktop -- SidePanel switches to
          `sm:static sm:w-96 sm:shrink-0` there, which only lines up correctly
          inside an actual flex row. */}
      <div className="relative flex flex-1 overflow-hidden">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {connectionStatus === "error" ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-brand-300">
              {connectionError ?? "No se pudo conectar la capa de Unify."}
            </div>
          ) : (
            <CompanionEmbedPane
              embed={degraded ?? draft.embed}
              displayName={draft.name}
              onLeave={handleLeave}
              onDegrade={(label, joinLink) => setDegraded({ kind: "external", label, joinLink })}
              subtitleStage={
                <CompanionSubtitleStage
                  lines={stageLines}
                  roleFor={roleFor}
                  avatarFor={avatarFor}
                  interim={captionsOn ? interimCaption : null}
                  interimSpeaker={draft.name || "Vos"}
                  interimAvatarUrl={user?.avatarUrl ?? null}
                  targetLabel={targetLabel}
                  translationFailed={translationFailed}
                  listening={connectionStatus === "connected" && captionsOn && !captionsProblem}
                  problem={captionsProblem}
                  onRetry={captionsSupported ? () => setMicAttempt((n) => n + 1) : undefined}
                  participantCount={participantCount}
                />
              }
            />
          )}

          <CompanionDock
            participantCount={participantCount}
            connected={connectionStatus === "connected"}
            targetLangChoice={targetLangChoice}
            onTargetLangChange={setTargetLangChoice}
            inviteUrl={inviteUrl}
            roomLabel={draft.roomLabel}
          />

          <LiveCaption
            lines={captionLines}
            roleFor={roleFor}
            avatarFor={avatarFor}
            localInterim={
              captionsOn && interimCaption
                ? {
                    speakerName: draft.name || "Vos",
                    text: interimCaption,
                    avatarUrl: user?.avatarUrl ?? null,
                  }
                : null
            }
          />

          <RecordingBanner
            status={recorder.status}
            uploadStatus={recorder.uploadStatus}
            error={recorder.error}
            resultUrl={recorder.resultUrl}
            resultType={recorder.resultType}
            kind={recorder.kind}
            selfCapture={recorder.selfCapture}
            // Pasar de sólo audio a pantalla necesita un clic: getDisplayMedia
            // exige un gesto del usuario, y este botón es ese gesto.
            onAddScreen={() => {
              recorder.stop();
              void recorder.start();
            }}
            onDismiss={recorder.reset}
          />
        </div>

        {/* SidePanel positions itself (overlay on mobile, static column on
            desktop beside the embed div above). */}
        {activePanel === "transcript" && (
          <TranscriptPanel
            onClose={() => setActivePanel(null)}
            targetLangChoice={targetLangChoice}
            resolvedTargetLang={targetLang}
            onTargetLangChange={setTargetLangChoice}
            getTranslation={getTranslation}
            spokenLang={spokenLang}
            onSpokenLangChange={setSelfLanguage}
          />
        )}

        {activePanel === "roles" && (
          <CompanionRolesPanel
            people={people}
            roles={roles}
            onChange={setRole}
            onClose={() => setActivePanel(null)}
          />
        )}

        {activePanel === "ai" && (
          <SidePanel title="Asistente IA" onClose={() => setActivePanel(null)}>
            {meeting?.dbId ? (
              <AiChatBox
                title="Preguntale a la IA"
                description="Tu asistente durante la reunión: responde sobre lo que se está diciendo, resume y saca conclusiones."
                placeholder='Ej: "resumime lo que se dijo hasta ahora"'
                emptyHint="La IA usa la transcripción en vivo de esta reunión externa."
                onAsk={(q) => askMeetingAI(meeting.dbId, q)}
              />
            ) : (
              <p className="text-sm text-ink-400">Conectando la reunión…</p>
            )}
          </SidePanel>
        )}
      </div>

      {/* Fixed bottom toolbar -- the Unify layer's controls. Mic / camera /
          screen-share / participants come from the embedded platform's own
          toolbar; these are the tools we add on top. */}
      <div className="flex items-center justify-center gap-2 border-t border-ink-800 bg-ink-900/95 px-3 py-3 shadow-top backdrop-blur-md sm:gap-3 sm:px-6">
        <IconButton
          label="Mostrar u ocultar los subtítulos en vivo"
          caption="Subtítulos"
          active={captionsOn}
          onClick={() => setCaptionsOn((v) => !v)}
        >
          <CaptionsIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label="Ver la transcripción completa y traducciones"
          caption="Transcripción"
          active={activePanel === "transcript"}
          onClick={() => togglePanel("transcript")}
        >
          <TranscriptIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label="Asignar roles a los participantes"
          caption="Roles"
          active={activePanel === "roles"}
          onClick={() => togglePanel("roles")}
        >
          <ShieldIcon className="h-5 w-5" />
        </IconButton>
        <IconButton
          label="Abrir el asistente de IA de la reunión"
          caption="IA"
          active={activePanel === "ai"}
          onClick={() => togglePanel("ai")}
        >
          <SparklesIcon className="h-5 w-5" />
        </IconButton>
        <div className={showRecHint ? "animate-pulse" : undefined}>
          <IconButton
            label={
              recording
                ? "Detener grabación"
                : !screenCaptureSupported
                  ? "La grabación no está disponible en este navegador"
                  : 'Grabar la reunión (elegí "esta pestaña" y tildá compartir audio)'
            }
            caption={recording ? "Grabando" : "Grabar"}
            danger={recording}
            onClick={toggleRecording}
          >
            {recording ? <StopIcon className="h-5 w-5" /> : <RecordIcon className="h-5 w-5" />}
          </IconButton>
        </div>
        <IconButton label="Salir de la reunión" caption="Salir" danger onClick={handleLeave}>
          <PhoneOffIcon className="h-5 w-5" />
        </IconButton>
      </div>
      {pendingLeave && <SaveMeetingPrompt onSave={confirmSaveMeeting} onSkip={skipSaveMeeting} />}
      {savingRecording && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-ink-900/90 px-8 py-7 text-center shadow-2xl">
            <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/20 border-t-brand-400" />
            <div>
              <p className="text-sm font-semibold text-white">Guardando grabación…</p>
              <p className="mt-1 text-xs text-white/60">
                No cierres esta pestaña. Terminamos de subir el video y seguimos.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
