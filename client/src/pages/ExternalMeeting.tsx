import { ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import AiChatBox from "../components/AiChatBox";
import BotButton from "../components/BotButton";
import IconButton from "../components/IconButton";
import JitsiEmbed from "../components/JitsiEmbed";
import LiveCaption from "../components/LiveCaption";
import CompanionDock from "../components/CompanionDock";
import CompanionRolesPanel from "../components/CompanionRolesPanel";
import CompanionSubtitleStage from "../components/CompanionSubtitleStage";
import ExternalCompanionPane from "../components/ExternalCompanionPane";
import IframeEmbed from "../components/IframeEmbed";
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
import { useReconocimientoDePista } from "../hooks/useReconocimientoDePista";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import {
  MENSAJE_MIC_BLOQUEADO,
  pedirCartelDeMedios,
  usePermisoDeMicrofono,
} from "../hooks/usePermisoDeMicrofono";
import { askMeetingAI } from "../lib/api";
import { LANGUAGES, etiquetaDeIdioma, shortLang } from "../lib/languages";
import { recentCaptionEntries } from "../lib/captionLines";
import { esIOS, screenCaptureSupported } from "../lib/screenCapture";
import { autoRecordEnabled, discardStashedDisplayStream, takeDisplayStream } from "../lib/autoRecord";
import { cerrarVentanaSiQuedoEnBlanco } from "../lib/ventanaReunion";
import { loadRoles, roleById, RoleMap, saveRoles } from "../lib/companionRoles";
import { setUnsavedMeeting } from "../lib/unsavedMeeting";
import { CompanionEmbed } from "../types";

type PanelKey = "transcript" | "ai" | "roles" | null;

// El <video> con los métodos de PiP que TypeScript no trae de fábrica:
// los webkit* son de Safari (iPad/iPhone/Mac), el resto es el estándar.
type VideoConPip = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (modo: string) => boolean;
  webkitSetPresentationMode?: (modo: "picture-in-picture" | "inline") => void;
  webkitPresentationMode?: string;
  requestPictureInPicture?: () => Promise<unknown>;
};

// ¿Este navegador puede flotar un video? (El camino de los subtítulos
// flotantes donde no existe el PiP de documento: Safari y Chrome móvil.)
function videoPipSoportado(): boolean {
  if (typeof document === "undefined") return false;
  const v = document.createElement("video") as VideoConPip;
  if (
    typeof v.webkitSupportsPresentationMode === "function" &&
    v.webkitSupportsPresentationMode("picture-in-picture")
  ) {
    return true;
  }
  const d = document as Document & { pictureInPictureEnabled?: boolean };
  return typeof v.requestPictureInPicture === "function" && d.pictureInPictureEnabled === true;
}

// Parte un texto en renglones que entran en el ancho del canvas.
function partirEnRenglones(ctx: CanvasRenderingContext2D, texto: string, ancho: number): string[] {
  const palabras = texto.split(/\s+/).filter(Boolean);
  const renglones: string[] = [];
  let actual = "";
  for (const p of palabras) {
    const prueba = actual ? `${actual} ${p}` : p;
    if (ctx.measureText(prueba).width <= ancho || !actual) actual = prueba;
    else {
      renglones.push(actual);
      actual = p;
    }
  }
  if (actual) renglones.push(actual);
  return renglones;
}

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
    case "jitsi": {
      const server = embed.domain || "meet.jit.si";
      return (
        <JitsiEmbed
          roomName={embed.roomName}
          domain={embed.domain}
          displayName={displayName}
          onLeave={onLeave}
          onFailure={() => onDegrade("Jitsi", `https://${server}/${embed.roomName}`)}
        />
      );
    }
    case "iframe":
      return (
        <IframeEmbed
          label={embed.label}
          embedUrl={embed.embedUrl}
          joinLink={embed.joinLink}
          onFailure={() => onDegrade(embed.label, embed.joinLink)}
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

// A qué reunión REAL mandaría el bot desde acá adentro, y bajo qué sala deja
// lo que escuche. Sólo las plataformas donde el bot sabe entrar: en las demás
// (Teams, un iframe suelto) ofrecerlo sería prometer algo que no pasa.
function enlaceParaElBot(
  embed: CompanionEmbed,
  externalKey: string,
): { url: string; roomKey: string; platform: string } | null {
  switch (embed.kind) {
    case "meet":
      return { url: embed.meetLink, roomKey: externalKey, platform: "google-meet" };
    case "zoom":
      // Sólo las salas SIN contraseña. Acá tenemos la contraseña en texto
      // plano, y un enlace de Zoom no la lleva así (lleva un token cifrado
      // que no podemos rehacer); el bot tampoco sabe tipearla. Ofrecerlo
      // igual sería mandarlo a golpear una puerta cerrada. Con contraseña, el
      // camino que sí funciona es el bot de la pantalla de entrada, que usa
      // el enlace original completo.
      return embed.passcode
        ? null
        : { url: `https://zoom.us/j/${embed.meetingNumber}`, roomKey: externalKey, platform: "zoom" };
    case "jitsi":
      return {
        url: `https://${embed.domain || "meet.jit.si"}/${embed.roomName}`,
        roomKey: externalKey,
        platform: "jitsi",
      };
    default:
      return null;
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
  // El celular MATA el reconocimiento cuando la pestaña pasa a segundo plano
  // (saltar a la app de Meet, bloquear la pantalla). Al volver, acá se
  // relanza solo: sin esto la pantalla quedaba muda para siempre y parecía
  // que "los subtítulos no funcionan".
  useEffect(() => {
    function alVolver() {
      if (document.visibilityState === "visible") setMicAttempt((n) => n + 1);
    }
    document.addEventListener("visibilitychange", alVolver);
    return () => document.removeEventListener("visibilitychange", alVolver);
  }, []);

  // Records the whole tab (the embedded meeting + captions) with its audio.
  // No local mic stream here -- the external platform owns the mic -- but
  // getDisplayMedia with "share tab audio" captures the meeting's audio.
  //
  // Va ANTES del reconocimiento a propósito: en iPhone/iPad hay que saber si
  // la grabación tiene tomado el micrófono para no encender los subtítulos
  // encima (ver abajo).
  const recorder = useRecorder({ micStream: null, meetingDbId: meeting?.dbId ?? null });

  // EL MICRÓFONO ES DE UNO SOLO (iPhone/iPad).
  //
  // En iOS el sistema le da la captura de audio a UNA cosa a la vez. Grabar
  // el micrófono y transcribirlo al mismo tiempo no falla con un error: el
  // sistema los deja mudos a los dos en silencio. Eso era exactamente lo que
  // se veía en el celular -- "Escuchando tu micrófono" y "Grabando audio"
  // juntos, cero subtítulos, y una grabación que terminaba vacía y sin
  // llegar al historial.
  //
  // La regla, entonces: en iOS mandan los SUBTÍTULOS (a eso vino la persona;
  // para que quede el video está el bot, que graba desde el servidor). La
  // grabación por micrófono no arranca sola acá, y si alguien la enciende a
  // propósito con el botón, los subtítulos se pausan mientras dure y vuelven
  // solos al detenerla.
  const unSoloMicrofono = esIOS();
  // `cediendoMic` es el traspaso en curso: alguien tocó Grabar y los
  // subtítulos tienen que SOLTAR el micrófono antes de que el grabador lo
  // pida. Sin este paso los dos lo piden a la vez y el sistema no se lo da a
  // ninguno -- el mismo choque que dejaba la pantalla muda y el archivo vacío.
  const [cediendoMic, setCediendoMic] = useState(false);
  const micTomadoPorGrabacion =
    unSoloMicrofono &&
    (cediendoMic ||
      (recorder.kind === "audio" &&
        (recorder.status === "recording" || recorder.status === "processing")));

  const { supported: captionsSupported, error: captionsError } = useSpeechRecognition({
    key: micAttempt,
    lang: spokenLang,
    active: connectionStatus === "connected" && !micTomadoPorGrabacion,
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
  // Permiso de micrófono mirado de frente (ver el hook): si está bloqueado
  // se avisa al instante, y cuando llega el reconocimiento se relanza solo.
  const micBloqueado = usePermisoDeMicrofono(micAttempt, () => setMicAttempt((n) => n + 1));
  // Y el CARTEL de autorización, de entrada: al entrar a la reunión (y en
  // cada Reintentar) se pide el micrófono para que el navegador muestre su
  // cartel nativo si el permiso está sin decidir -- nadie tiene que ir a
  // Configuración salvo que lo haya bloqueado "para siempre".
  const cartelListoRef = useRef(false);
  useEffect(() => {
    // Sin reconocimiento de voz (Firefox, Safari de compu) el micrófono no
    // sirve de nada acá: pedirlo al lado del cartel "este navegador no puede
    // transcribir" sería un permiso sin propósito. No se pide.
    if (!captionsSupported) return;
    let vivo = true;
    void (async () => {
      try {
        const p = await navigator.permissions?.query?.({ name: "microphone" as PermissionName });
        if (p?.state === "granted") {
          cartelListoRef.current = true;
          return;
        }
      } catch {
        // sin permissions.query: pedir igual
      }
      const r = await pedirCartelDeMedios();
      // Con el permiso recién dado, el reconocimiento se relanza ya
      // autorizado -- una sola vez, para no pedir en bucle donde el
      // navegador no sabe contarnos el estado del permiso.
      if (vivo && r === "concedido" && !cartelListoRef.current) {
        cartelListoRef.current = true;
        setMicAttempt((n) => n + 1);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [micAttempt, captionsSupported]);

  const captionsProblem = !captionsSupported
    ? "Este navegador no puede transcribir voz. Para ver subtítulos, entrá desde Chrome o Edge (en iPhone/iPad, desde la app de Chrome)."
    : micBloqueado
      ? MENSAJE_MIC_BLOQUEADO
      : micTomadoPorGrabacion
        ? "Los subtítulos están en pausa mientras grabás el audio: en iPhone y iPad el micrófono es de una sola cosa a la vez. Tocá «Grabando» abajo para detener la grabación y que vuelvan los subtítulos."
        : captionsError;

  // Vigía de silencio. "Escuchando tu micrófono" con CERO frases durante 20
  // segundos de reunión no es normal: casi siempre es iOS dándole el
  // micrófono a la app de la llamada (Meet/Zoom) en este MISMO aparato --
  // el reconocimiento arranca sin error pero nunca le llega audio. Antes la
  // pantalla mentía "Escuchando" para siempre; ahora avisa y explica las
  // salidas reales.
  const escuchando = connectionStatus === "connected" && captionsOn && !captionsProblem;
  const [silencioLargo, setSilencioLargo] = useState(false);
  const ultimaVozRef = useRef(Date.now());
  const transcriptLargo = meeting?.transcript.length ?? 0;
  useEffect(() => {
    ultimaVozRef.current = Date.now();
    setSilencioLargo(false);
  }, [interimCaption, transcriptLargo, micAttempt]);
  useEffect(() => {
    if (!escuchando) {
      setSilencioLargo(false);
      return;
    }
    ultimaVozRef.current = Date.now();
    const t = window.setInterval(() => {
      setSilencioLargo(Date.now() - ultimaVozRef.current > 20000);
    }, 5000);
    return () => window.clearInterval(t);
  }, [escuchando, micAttempt]);
  const avisoSilencio = silencioLargo
    ? "No está llegando ninguna voz al micrófono. Si la reunión corre en su app en este mismo aparato, el sistema le da el micrófono a la llamada y Unify no escucha nada. Salidas: dejá la reunión sonando en ALTAVOZ (sin auriculares) y esta pantalla al frente, abrila desde el navegador con Unify al lado (en iPad: Split View), o mandá el bot desde la pantalla de unirse: graba y transcribe todo desde el servidor, sin depender de este micrófono."
    : null;

  const { getTranslation, translationFailed } = useLineTranslations(meeting?.transcript ?? [], targetLang);

  // El bot, ofrecido DESDE ADENTRO. La escena donde más falta hace es esta:
  // la reunión corre en la app de este mismo teléfono, el sistema le da el
  // micrófono a la llamada y Unify no escucha nada. El bot no depende de
  // ningún micrófono de nadie -- entra desde el servidor, graba y transcribe.
  const botDeSala =
    draft?.mode === "companion" ? enlaceParaElBot(draft.embed, draft.externalKey) : null;

  // El botón de grabar. Donde no existe capturar la pantalla (iPhone/iPad)
  // grabar significa el MICRÓFONO: pedir pantalla ahí sólo daba un error. Al
  // encenderla, los subtítulos se pausan solos mientras dure (ver arriba).
  function toggleRecording() {
    if (recorder.status === "recording") recorder.stop();
    else if (recorder.status === "idle" || recorder.status === "error") {
      if (screenCaptureSupported) {
        // Grabar la pantalla no toca el micrófono: arranca derecho.
        void recorder.start({});
      } else if (unSoloMicrofono) {
        // Donde el micrófono es de uno solo, PRIMERO se lo sueltan los
        // subtítulos y recién después lo pide el grabador. Pedirlo de una
        // (como hacía este botón) era caer en el mismo choque que dejaba
        // sin subtítulos Y con la grabación vacía. El reset deja el estado
        // en "idle" para que el traspaso arranque igual después de un fallo.
        recorder.reset();
        setCediendoMic(true);
      } else {
        void recorder.start({ audioOnly: true });
      }
    }
  }

  // --- Las voces de LOS DEMÁS -----------------------------------------------
  // El micrófono de arriba sólo escucha a quien tiene Unify abierto; la gente
  // que entra por Zoom/Meet/la app que sea quedaba fuera de los subtítulos y
  // de la transcripción. Su voz SÍ está en el audio que viene con la captura
  // de pantalla/pestaña: se le pasa esa pista al reconocimiento (Chrome 139+)
  // y cada frase viaja como línea de "La reunión" -- con la misma IA
  // correctora y traducida al idioma de cada uno, igual que el resto.
  const { soportado: reunionSoportada } = useReconocimientoDePista({
    track: recorder.remoteAudioTrack,
    lang: spokenLang,
    onFinal: (alternativas) =>
      sendTranscriptLine(alternativas, spokenLang, { screen: true, origen: "reunion" }),
  });
  // Los dos huecos que dejarían a "los demás" sin subtítulos, avisados en el
  // mismo cartel donde se explican los problemas de subtítulos: la captura
  // vino sin audio (no tildaron "compartir audio"), o el navegador no sabe
  // transcribir una pista (Chrome viejo).
  // Detección estática de un Chrome viejo (sin reconocimiento por pista):
  // mejor avisarlo al ENTRAR que descubrirlo recién al grabar.
  const [chromeSinPista] = useState(() => {
    const Ctor =
      window.SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: typeof window.SpeechRecognition })
        .webkitSpeechRecognition;
    return !Ctor || typeof (Ctor as { available?: unknown }).available !== "function";
  });
  // En el celular no existe capturar pantalla/audio de la reunión: ahí el
  // modo es el altavoz (la pantalla lo explica) y avisar "actualizá Chrome"
  // sólo confundía. El aviso corre únicamente donde la captura es posible.
  const capturaPosible = typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const avisoReunion =
    recorder.status === "recording" && recorder.kind === "screen" && !recorder.remoteAudioTrack
      ? "La grabación no trae el audio de la reunión, así que los demás no salen en los subtítulos: paren y vuelvan a grabar tildando «Compartir audio» al elegir la pestaña o pantalla."
      : capturaPosible && (chromeSinPista || (recorder.remoteAudioTrack && !reunionSoportada))
        ? "Para que los DEMÁS también salgan en los subtítulos, actualizá Chrome (este navegador no puede transcribir el audio de la reunión)."
        : null;

  // --- Grabación automática -------------------------------------------------
  // En una reunión externa la grabación no se pide: arranca sola. Con la
  // captura de pantalla que se consiguió durante el clic de "Unirme" graba
  // video+audio; sin ella (URL directa, recarga, o cancelaron el selector)
  // graba el audio, que no necesita ningún gesto del usuario. En los dos
  // casos, sin que nadie apriete nada.
  const autoStartedRef = useRef(false);
  const startRef = useRef(recorder.start);
  startRef.current = recorder.start;
  // ¿Cedimos la grabación automática para que anden los subtítulos? (Sólo
  // iPhone/iPad, y sólo cuando este navegador SÍ puede transcribir: si no
  // puede, el micrófono está libre y grabar es lo mejor que se puede hacer.)
  const grabacionCedida = unSoloMicrofono && captionsSupported;
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (connectionStatus !== "connected" || !meeting?.dbId) return;
    autoStartedRef.current = true;
    if (!autoRecordEnabled()) {
      discardStashedDisplayStream();
      return;
    }
    const stream = takeDisplayStream();
    // En iPhone/iPad, arrancar a grabar el micrófono acá dejaba los
    // subtítulos mudos (el sistema no lo comparte) Y la grabación vacía: se
    // perdían las dos cosas. Sin captura de pantalla que grabar, no se
    // arranca sola -- manda el subtítulo, y el botón de grabar sigue ahí
    // para quien prefiera el audio.
    if (!stream && grabacionCedida) return;
    void startRef.current(stream ? { stream } : { audioOnly: true });
  }, [connectionStatus, meeting?.dbId, grabacionCedida]);

  // El traspaso del micrófono, de los subtítulos a la grabación. Cuando este
  // efecto corre, el reconocimiento YA quedó apagado en este mismo render
  // (micTomadoPorGrabacion pasó a true): el respiro es para que el sistema
  // termine de largar el micrófono antes de que el grabador lo pida.
  const traspasoPedidoRef = useRef(false);
  useEffect(() => {
    if (!cediendoMic) {
      traspasoPedidoRef.current = false;
      return;
    }
    // Desenlace: el grabador ya tomó el micrófono, o no pudo. En los dos
    // casos el traspaso terminó (y si falló, los subtítulos vuelven).
    if (recorder.status !== "idle") {
      setCediendoMic(false);
      return;
    }
    // El pedido ya salió: se espera su desenlace, no se dispara de nuevo
    // (si no, un permiso denegado dejaba el botón reintentando para siempre).
    if (traspasoPedidoRef.current) return;
    traspasoPedidoRef.current = true;
    const t = window.setTimeout(() => {
      void startRef.current({ audioOnly: true });
    }, 400);
    return () => window.clearTimeout(t);
  }, [cediendoMic, recorder.status]);

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

  // La fecha límite se ancla UNA vez al pedir la salida: el setTimeout del
  // efecto de abajo se reseteaba con cada transición de la grabación
  // (procesando -> subiendo -> reintento) y el "tope de 30s" se corría
  // infinitamente -- el spinner eterno del iPad.
  const savingDeadlineRef = useRef(0);

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
    savingDeadlineRef.current = Date.now() + 30000;
    setSavingRecording(true);
  }

  // La salida diferida, ejecutable también a mano (el botón "Salir igual").
  function completarSalida() {
    if (leftRef.current) return;
    leftRef.current = true;
    const exit = pendingExitRef.current;
    pendingExitRef.current = null;
    exit?.();
  }

  // Completes the deferred exit once the recording is uploaded (or once the
  // anchored deadline passes, so a stuck upload can never trap someone).
  useEffect(() => {
    if (!savingRecording || leftRef.current) return;
    const busy =
      recorder.status === "recording" ||
      recorder.status === "processing" ||
      recorder.uploadStatus === "uploading";
    const restante = Math.max(0, savingDeadlineRef.current - Date.now());
    if (!busy || restante === 0) {
      completarSalida();
      return;
    }
    const t = setTimeout(completarSalida, restante);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // --- Puente con la app de escritorio --------------------------------------
  // Cuando esta barra la abrió la app de escritorio de Unify (detectó que la
  // app de Zoom entró a una reunión), la app publica en 127.0.0.1:47125 si la
  // reunión sigue en pie. Al terminar, acá se corta la grabación, se espera la
  // subida y se abre el detalle en el historial (o el aviso de guardar, para
  // invitados) -- sin que nadie toque nada. Dos lecturas seguidas de "terminó"
  // antes de actuar: un tropiezo del puente no tiene que cortar una reunión
  // que sigue viva.
  const escritorioRef = useRef(sessionStorage.getItem("unify_escritorio") === "1");
  // La marca se consume al entrar (como unify_autorec): si quedara colgada y
  // esta misma pestaña abriera después una reunión externa común, el modo
  // escritorio la cortaría solo al no encontrar el puente.
  useEffect(() => {
    sessionStorage.removeItem("unify_escritorio");
  }, []);
  const finishFromDesktopRef = useRef<() => void>(() => {});
  finishFromDesktopRef.current = () => {
    if (recorder.status === "recording") recorder.stop();
    const dbId = meeting?.dbId ?? null;
    if (!user && dbId) {
      setPendingLeave(dbId);
      return;
    }
    exitWhenSaved(() => {
      leaveMeeting();
      navigate(user && dbId ? `/historial/${dbId}` : "/", { replace: true });
    });
  };
  useEffect(() => {
    if (!escritorioRef.current || connectionStatus !== "connected") return;
    let terminadas = 0;
    let hecho = false;
    const timer = setInterval(async () => {
      if (hecho) return;
      try {
        const res = await fetch("http://127.0.0.1:47125/estado", { cache: "no-store" });
        const est = (await res.json()) as { enReunion?: boolean };
        terminadas = est.enReunion ? 0 : terminadas + 1;
      } catch {
        // El puente no responde: la app se cerró o nunca estuvo. Cuenta como
        // "terminó" -- sin app no hay quien vigile a Zoom.
        terminadas += 1;
      }
      if (terminadas < 2) return;
      hecho = true;
      clearInterval(timer);
      finishFromDesktopRef.current();
    }, 2500);
    return () => clearInterval(timer);
  }, [connectionStatus]);

  // Si la app de Meet/Zoom se llevó el enlace que abrimos, la pestaña quedó
  // huérfana en blanco: apenas Unify vuelve a estar visible, se cierra para
  // que el próximo regreso a Safari caiga acá y no en una página vacía.
  useEffect(() => {
    const alVolver = () => cerrarVentanaSiQuedoEnBlanco();
    document.addEventListener("visibilitychange", alVolver);
    window.addEventListener("focus", alVolver);
    return () => {
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("focus", alVolver);
    };
  }, []);

  // --- Subtítulos flotantes (Picture-in-Picture) ----------------------------
  // La ventanita que queda SIEMPRE encima: cuando la reunión vive en otra app
  // (el Zoom de escritorio, el Meet del iPad) o alguien comparte a pantalla
  // completa, esta barra puede quedar tapada -- los subtítulos, con su
  // traducción, siguen a la vista flotando sobre todo.
  //
  // Dos caminos: el PiP de DOCUMENTO (Chrome 116+ de compu) y, donde no
  // existe (Safari de iPad/iPhone, Chrome de Android), el PiP de VIDEO: los
  // subtítulos se dibujan en un canvas que se transmite como video flotante.
  const pipRef = useRef<Window | null>(null);
  const videoPipRef = useRef<{
    video: HTMLVideoElement;
    canvas: HTMLCanvasElement;
    stream: MediaStream;
  } | null>(null);
  const [pipAbierto, setPipAbierto] = useState(false);
  const docPipSoportado =
    typeof (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture !==
    "undefined";
  const [videoPipDisponible] = useState(videoPipSoportado);
  const pipSoportado = docPipSoportado || videoPipDisponible;
  function cerrarFlotantes() {
    pipRef.current?.close();
    pipRef.current = null;
    const vp = videoPipRef.current;
    if (vp) {
      videoPipRef.current = null;
      const v = vp.video as VideoConPip;
      try {
        v.webkitSetPresentationMode?.("inline");
      } catch {
        // ya estaba inline
      }
      try {
        const d = document as Document & {
          pictureInPictureElement?: Element | null;
          exitPictureInPicture?: () => Promise<void>;
        };
        if (d.pictureInPictureElement === vp.video) void d.exitPictureInPicture?.();
      } catch {
        // ya había salido
      }
      for (const t of vp.stream.getTracks()) t.stop();
      vp.video.remove();
    }
    setPipAbierto(false);
  }
  async function toggleFlotantes() {
    if (pipRef.current || videoPipRef.current) {
      cerrarFlotantes();
      return;
    }
    if (!docPipSoportado) {
      await abrirFlotantesDeVideo();
      return;
    }
    try {
      const api = (
        window as unknown as {
          documentPictureInPicture: {
            requestWindow: (o: { width: number; height: number }) => Promise<Window>;
          };
        }
      ).documentPictureInPicture;
      const win = await api.requestWindow({ width: 440, height: 190 });
      win.document.body.style.cssText =
        "margin:0;background:#0b1020;color:#fff;font-family:system-ui,sans-serif;overflow:hidden";
      const cont = win.document.createElement("div");
      cont.id = "subs";
      cont.style.cssText =
        "display:flex;flex-direction:column;justify-content:flex-end;gap:6px;height:100vh;padding:10px 14px;box-sizing:border-box";
      win.document.body.appendChild(cont);
      win.addEventListener("pagehide", () => {
        pipRef.current = null;
        setPipAbierto(false);
      });
      pipRef.current = win;
      setPipAbierto(true);
    } catch {
      // Permiso denegado o bloqueado: decirlo, no quedarse mudo.
      avisarFlotantes("El navegador no dejó abrir la ventanita flotante (permiso bloqueado).");
    }
  }
  // El camino sin PiP de documento (iPad, iPhone, Android): los subtítulos
  // se dibujan en un canvas, el canvas se captura como stream y un <video>
  // chiquito lo flota. La ventanita queda encima de CUALQUIER app -- también
  // cuando la reunión vive en la app de Meet y Unify quedó en Safari.
  async function abrirFlotantesDeVideo() {
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 240;
    pintarCanvasPip(canvas);
    let video: VideoConPip | null = null;
    let stream: MediaStream | null = null;
    try {
      stream = canvas.captureStream(5);
      video = document.createElement("video") as VideoConPip;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.srcObject = stream;
      // Vista previa VISIBLE en la esquina: el toque siempre produce algo a
      // la vista (antes, si el PiP fallaba, el botón "no hacía nada"). En
      // iOS además un video oculto directamente no puede entrar a PiP.
      video.style.cssText =
        "position:fixed;right:12px;bottom:88px;width:176px;height:59px;border-radius:12px;" +
        "border:1px solid #dbe7fb;box-shadow:0 8px 24px rgba(15,23,42,.18);background:#fff;" +
        "object-fit:cover;pointer-events:none;z-index:60";
      document.body.appendChild(video);
      await video.play();
    } catch {
      // Ni siquiera se pudo armar el video local: limpiar y avisar honesto.
      if (stream) for (const t of stream.getTracks()) t.stop();
      video?.remove();
      avisarFlotantes("No se pudieron armar los subtítulos flotantes en este navegador.");
      return;
    }
    const alSalir = () => {
      if (!videoPipRef.current) return;
      videoPipRef.current = null;
      if (stream) for (const t of stream.getTracks()) t.stop();
      video?.remove();
      setPipAbierto(false);
    };
    video.addEventListener("leavepictureinpicture", alSalir);
    video.addEventListener("webkitpresentationmodechanged", () => {
      if ((video as VideoConPip).webkitPresentationMode === "inline") alSalir();
    });
    // La ventanita queda armada YA (vista previa incluida); si el PiP real
    // no entra, el botón igual hizo algo visible y se explica el porqué.
    videoPipRef.current = { video, canvas, stream };
    setPipAbierto(true);
    // iOS se niega a flotar un video sin su primer cuadro decodificado:
    // esperarlo (con tope corto, para no perder la activación del toque).
    if (video.readyState < 2) {
      await new Promise<void>((res) => {
        const listo = () => res();
        video!.addEventListener("loadeddata", listo, { once: true });
        window.setTimeout(listo, 1200);
      });
    }
    try {
      if (
        typeof video.webkitSetPresentationMode === "function" &&
        video.webkitSupportsPresentationMode?.("picture-in-picture")
      ) {
        video.webkitSetPresentationMode("picture-in-picture");
      } else if (video.requestPictureInPicture) {
        await video.requestPictureInPicture();
      } else {
        throw new Error("sin PiP de video");
      }
    } catch {
      avisarFlotantes(
        "La ventanita flotante no abrió en este navegador: te dejamos los subtítulos en la esquina de esta pantalla.",
      );
    }
  }
  // Aviso corto y honesto sobre los flotantes, al lado del dock.
  const [flotantesAviso, setFlotantesAviso] = useState<string | null>(null);
  const avisoTimerRef = useRef<number | null>(null);
  function avisarFlotantes(texto: string) {
    setFlotantesAviso(texto);
    if (avisoTimerRef.current) window.clearTimeout(avisoTimerRef.current);
    avisoTimerRef.current = window.setTimeout(() => setFlotantesAviso(null), 7000);
  }
  // Dibuja las últimas frases (con su traducción) en el canvas del PiP de
  // video: fondo blanco Unify, quién habla en azul, el texto en oscuro.
  function pintarCanvasPip(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    const margen = 22;
    const ancho = W - margen * 2;
    // Frases de la más nueva a la más vieja, dibujadas de abajo hacia arriba.
    const frases: { quien: string; texto: string; interina?: boolean }[] = [];
    if (captionsOn && interimCaption) {
      frases.push({ quien: draft?.name || "Vos", texto: interimCaption, interina: true });
    }
    for (const l of [...transcriptPip.slice(-3)].reverse()) {
      frases.push({ quien: l.speakerName, texto: getTranslation(l.id) ?? l.text });
    }
    let y = H - 18;
    for (const f of frases) {
      ctx.font = f.interina ? "italic 24px system-ui, sans-serif" : "24px system-ui, sans-serif";
      ctx.fillStyle = f.interina ? "#64748b" : "#1e293b";
      const renglones = partirEnRenglones(ctx, f.texto, ancho);
      for (let i = renglones.length - 1; i >= 0; i--) {
        if (y < 60) return;
        ctx.fillText(renglones[i], margen, y);
        y -= 30;
      }
      if (y < 60) return;
      ctx.font = "600 17px system-ui, sans-serif";
      ctx.fillStyle = "#2563EB";
      ctx.fillText(f.quien, margen, y);
      y -= 32;
    }
  }
  // Cada frase nueva (o su traducción, que llega después) repinta la ventana.
  // Siempre por textContent, nunca innerHTML: lo dicho en la reunión es texto.
  const transcriptPip = meeting?.transcript ?? [];
  useEffect(() => {
    if (videoPipRef.current) pintarCanvasPip(videoPipRef.current.canvas);
    const win = pipRef.current;
    if (!pipAbierto || !win) return;
    const cont = win.document.getElementById("subs");
    if (!cont) return;
    cont.textContent = "";
    for (const l of transcriptPip.slice(-3)) {
      const fila = win.document.createElement("div");
      fila.style.cssText = "font-size:15px;line-height:1.35";
      const quien = win.document.createElement("span");
      quien.textContent = `${l.speakerName}: `;
      quien.style.cssText = "color:#7fa5ff;font-weight:600";
      const texto = win.document.createElement("span");
      texto.textContent = getTranslation(l.id) ?? l.text;
      fila.appendChild(quien);
      fila.appendChild(texto);
      cont.appendChild(fila);
    }
    if (captionsOn && interimCaption) {
      const fila = win.document.createElement("div");
      fila.textContent = `${draft?.name || "Vos"}: ${interimCaption}`;
      fila.style.cssText = "font-size:15px;line-height:1.35;opacity:.6;font-style:italic";
      cont.appendChild(fila);
    }
  });
  // Al irse de la pantalla, la ventanita no queda flotando huérfana.
  useEffect(
    () => () => {
      pipRef.current?.close();
      const vp = videoPipRef.current;
      if (vp) {
        videoPipRef.current = null;
        for (const t of vp.stream.getTracks()) t.stop();
        vp.video.remove();
      }
    },
    [],
  );
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
              : e.kind === "iframe"
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
          {/* SIEMPRE tiene que haber un Volver a la vista (regla de la casa):
              el Salir del dock de abajo no alcanza si no se lo reconoce. Pasa
              por handleLeave, el salir seguro (guarda y reclama antes de irse). */}
          <button
            type="button"
            onClick={handleLeave}
            aria-label="Volver al inicio (salís de la reunión)"
            className="-my-2 flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-3 text-sm font-medium text-ink-300 hover:bg-ink-800 hover:text-strong"
          >
            <span aria-hidden>←</span> Volver
          </button>
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
                  listening={escuchando}
                  problem={captionsProblem ?? avisoSilencio ?? avisoReunion}
                  onRetry={captionsSupported ? () => setMicAttempt((n) => n + 1) : undefined}
                  accionBot={
                    botDeSala ? (
                      <BotButton
                        url={botDeSala.url}
                        roomKey={botDeSala.roomKey}
                        platform={botDeSala.platform}
                        lang={spokenLang}
                        titulo="¿Este aparato no escucha la reunión?"
                        descripcion="Mandá el bot: entra a la reunión, graba y transcribe todo desde el servidor. No usa el micrófono de tu teléfono, así que funciona aunque la llamada esté en este mismo aparato."
                      />
                    ) : null
                  }
                  notaGrabacion={
                    grabacionCedida && recorder.status === "idle"
                      ? "En iPhone y iPad el micrófono es de una sola cosa a la vez, así que la grabación automática está en pausa para que anden los subtítulos. Si querés que quede el video y la transcripción completa en el historial, mandá el bot al entrar: graba desde el servidor y no usa este micrófono. También podés tocar «Grabar» abajo para guardar el audio (mientras dure, los subtítulos se pausan)."
                      : null
                  }
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
            onFlotantes={pipSoportado ? () => void toggleFlotantes() : null}
            flotantesActivo={pipAbierto}
            autoLabel={etiquetaDeIdioma(spokenLang)}
          />
          {flotantesAviso && (
            <div className="fixed right-4 top-28 z-40 max-w-[260px] rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-200 shadow-lg backdrop-blur">
              {flotantesAviso}
            </div>
          )}

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
            // exige un gesto del usuario, y este botón es ese gesto. En el
            // celular no existe capturar pantalla: ahí el botón ni aparece.
            onAddScreen={
              typeof navigator.mediaDevices?.getDisplayMedia === "function"
                ? () => {
                    recorder.stop();
                    void recorder.start();
                  }
                : undefined
            }
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
                  ? "Grabar el audio por el micrófono (mientras grabás, los subtítulos se pausan)"
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
        // Tokens de tema (la versión anterior era texto blanco sobre una
        // tarjeta que en tema claro es casi blanca: un modal "vacío"), más la
        // salida a mano para que nadie quede rehén de una subida lenta.
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 backdrop-blur-sm">
          <div className="mx-6 flex max-w-sm flex-col items-center gap-4 rounded-2xl border border-ink-600 bg-ink-800 px-8 py-7 text-center shadow-2xl">
            <div className="h-9 w-9 animate-spin rounded-full border-2 border-ink-600 border-t-brand-500" />
            <div>
              <p className="text-sm font-semibold text-strong">Guardando la grabación…</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-300">
                {recorder.status === "processing"
                  ? "Preparando el archivo del video…"
                  : recorder.uploadStatus === "uploading"
                    ? "Subiendo la grabación al historial…"
                    : "Terminando de guardar…"}
              </p>
            </div>
            <button
              type="button"
              onClick={completarSalida}
              className="rounded-full border border-ink-600 px-5 py-2 text-xs font-semibold text-ink-200 hover:border-brand-400 hover:text-strong"
            >
              Salir igual
            </button>
            <p className="text-[11px] leading-snug text-ink-400">
              Si salís, la subida sigue sola; y si no llega, la grabación queda guardada en este
              dispositivo y se reintenta desde el historial.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
