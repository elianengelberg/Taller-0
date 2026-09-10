import { ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import AiChatBox from "../components/AiChatBox";
import BotButton from "../components/BotButton";
import JitsiEmbed from "../components/JitsiEmbed";
import LiveCaption from "../components/LiveCaption";
import CompanionRolesPanel from "../components/CompanionRolesPanel";
import CompanionSubtitleStage from "../components/CompanionSubtitleStage";
import ExternalCompanionPane from "../components/ExternalCompanionPane";
import AjustesDeReunion from "../components/AjustesDeReunion";
import AvisoSoloTuVoz from "../components/AvisoSoloTuVoz";
import BarraDeReunion from "../components/BarraDeReunion";
import EstadoDeEscucha, { ModoDeEscucha } from "../components/EstadoDeEscucha";
import IframeEmbed from "../components/IframeEmbed";
import MeetCompanionPane from "../components/MeetCompanionPane";
import RecordingBanner from "../components/RecordingBanner";
import { Accion, Barra, Interruptor, Selector, Separador } from "../components/BarraDeAcciones";
import SaveMeetingPrompt from "../components/SaveMeetingPrompt";
import SidePanel from "../components/SidePanel";
import TeamsEmbed from "../components/TeamsEmbed";
import TranscriptPanel from "../components/TranscriptPanel";
import ZoomEmbed from "../components/ZoomEmbed";
import {
  CaptionsIcon,
  MicIcon,
  MicOffIcon,
  PeopleIcon,
  ShieldIcon,
  PhoneOffIcon,
  SparklesIcon,
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
import { askMeetingAI, fetchPlatformConfig, ordenarEnLaReunion, type PlatformConfig } from "../lib/api";
import { usePantallaChica } from "../lib/pantalla";
import { SERVER_URL } from "../lib/socket";
import { LANGUAGES, codigoCompletoDe, etiquetaDeIdioma, shortLang } from "../lib/languages";
import { recentCaptionEntries } from "../lib/captionLines";
import {
  FraseFlotante,
  pintarFlotantesEnCanvas,
  pintarFlotantesEnDocumento,
  prepararVentanaFlotante,
} from "../lib/flotantes";
import { comoVerLosDosALaVez, detectarDispositivo } from "../lib/dispositivo";
import { esIOS, screenCaptureSupported } from "../lib/screenCapture";
import { autoRecordEnabled, discardStashedDisplayStream, takeDisplayStream } from "../lib/autoRecord";
import { abrirVentanaReunion, cerrarVentanaSiQuedoEnBlanco } from "../lib/ventanaReunion";
import { loadRoles, roleById, RoleMap, saveRoles } from "../lib/companionRoles";
import { setUnsavedMeeting } from "../lib/unsavedMeeting";
import { CompanionEmbed } from "../types";

type PanelKey = "transcript" | "ai" | "roles" | "ajustes" | null;

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

// Renders the actual external-meeting pane for a companion session. One branch
// per embeddable platform; adding a new platform means adding a case here.
function CompanionEmbedPane({
  embed,
  displayName,
  onLeave,
  onDegrade,
  subtitleStage,
  compacto = false,
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
  onDegrade: (label: string, joinLink: string, nota?: string, abrirYa?: boolean) => void;
  subtitleStage?: ReactNode;
  /** La pantalla quedó chica: los subtítulos mandan (ver lib/pantalla). */
  compacto?: boolean;
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
          onFailure={(motivo, gesto) =>
            onDegrade("Zoom", embed.joinLink ?? `https://zoom.us/j/${embed.meetingNumber}`, motivo, gesto)
          }
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
          compacto={compacto}
          meetLink={embed.meetLink}
          meetCode={embed.meetCode}
          subtitleStage={subtitleStage}
        />
      );
    case "external":
      return (
        <ExternalCompanionPane
          compacto={compacto}
          label={embed.label}
          joinLink={embed.joinLink}
          nota={embed.nota}
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
    meetState,
    // Lo que otro está diciendo ahora mismo (bot / extensión), sin esperar a
    // que termine la frase.
    interinoAjeno,
    sendInterim,
  } = useMeeting();

  const [activePanel, setActivePanel] = useState<PanelKey>(null);
  // La pantalla achicada (Split View, una ventana angosta): los subtítulos
  // pasan al frente y todo lo demás se corre.
  const compacto = usePantallaChica();
  // LOS BOTONES QUE DE VERDAD TOCAN LA REUNIÓN. La llamada vive en Meet, no
  // acá: silenciar y cortar sólo se pueden hacer si la extensión está en esa
  // pestaña (ella aprieta los botones de Meet). Si no está, no se muestran:
  // un botón que no hace nada es peor que no tener botón (reporte real:
  // "apretaba mutear y no me muteaba, apretaba cortar y no cortaba").
  const [ordenEnCurso, setOrdenEnCurso] = useState<string | null>(null);
  const extensionViva = Boolean(meetState && Date.now() - meetState.at < 30_000 && meetState.inCall);
  async function ordenar(accion: "mic-toggle" | "cam-toggle" | "colgar") {
    if (!roomKey) return;
    setOrdenEnCurso(accion);
    await ordenarEnLaReunion(roomKey, accion);
    window.setTimeout(() => setOrdenEnCurso(null), 1200);
  }
  // Qué tiene configurado el servidor (acá importa Zoom sin bot: cambia qué
  // hace «mandar el bot» en una reunión de Zoom).
  const [platforms, setPlatforms] = useState<PlatformConfig | null>(null);
  useEffect(() => {
    fetchPlatformConfig().then(setPlatforms);
  }, []);
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

  // CÓMO VIENE LA GRABACIÓN DEL BOT. La reunión aparecía en el historial sin
  // video y no había forma de saber por qué (reporte real). El bot ahora
  // avisa cada paso a la sala y acá se muestra: grabando, subiendo, guardada
  // o el motivo del fallo.
  const [grabacionBot, setGrabacionBot] = useState<{ estado: string; detalle: string | null } | null>(null);
  // Y en qué anda el bot: es lo que contesta «¿hay alguien escuchando esta
  // reunión aunque yo cierre esto?» -- la pregunta central de la pantalla.
  const [faseBot, setFaseBot] = useState<string | null>(null);
  useEffect(() => {
    if (!roomKey) return;
    let vivo = true;
    const mirar = async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/meet-bridge/${encodeURIComponent(roomKey)}/session`);
        if (!r.ok || !vivo) return;
        const d = (await r.json()) as {
          grabacion?: { estado: string; detalle: string | null } | null;
          bot?: { fase: string } | null;
        };
        if (vivo) setFaseBot(d.bot?.fase ?? null);
        if (vivo) setGrabacionBot(d.grabacion ?? null);
      } catch {
        /* la próxima vuelta */
      }
    };
    void mirar();
    const t = window.setInterval(() => void mirar(), 5_000);
    return () => {
      vivo = false;
      window.clearInterval(t);
    };
  }, [roomKey]);
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

  // EL IDIOMA EN QUE HABLAN LOS DEMÁS. El oído de "la reunión" (el audio de
  // la captura) escuchaba en TU idioma: si te hablaban en inglés con el oído
  // en español salían palabras inventadas -- y encima, etiquetadas como
  // español, no se traducían. Ahora tiene su propio idioma: el que la
  // persona elige en el dock («Se habla en la reunión»), y en «Automático»
  // el tuyo, pero cambia solo cuando dos frases seguidas de los demás llegan
  // en otro idioma (el servidor detecta el idioma real de cada frase).
  const [idiomaReunionElegido, setIdiomaReunionElegido] = useState<string>(() => {
    try {
      return localStorage.getItem("unify_lang_reunion") ?? "";
    } catch {
      return "";
    }
  });
  const [idiomaReunionAuto, setIdiomaReunionAuto] = useState<string>("");
  const [avisoIdiomaAjeno, setAvisoIdiomaAjeno] = useState<string | null>(null);
  const langReunion = idiomaReunionElegido || idiomaReunionAuto || spokenLang;
  const elegirIdiomaReunion = (valor: string) => {
    setIdiomaReunionElegido(valor);
    setAvisoIdiomaAjeno(null);
    setReunionBilingue(false);
    try {
      if (valor) localStorage.setItem("unify_lang_reunion", valor);
      else localStorage.removeItem("unify_lang_reunion");
    } catch {
      /* modo privado: vale para esta reunión */
    }
  };
  // CUÁNTAS VECES YA CAMBIÓ SOLO, Y CUÁNDO. En una reunión donde se mezclan
  // dos idiomas (alguien dice «hello», otro contesta en español) la regla de
  // «dos frases seguidas en otro idioma» se cumple UNA Y OTRA VEZ, en los dos
  // sentidos: el oído saltaba de español a inglés y de vuelta sin parar, con
  // un cartel enorme cada vez. Se vio así en una reunión real, con el aviso
  // clavado en pantalla tapando el selector de «Traducir».
  const ultimoCambioDeIdioma = useRef(0);
  const cambiosDeIdioma = useRef(0);
  const [reunionBilingue, setReunionBilingue] = useState(false);
  useEffect(() => {
    if (idiomaReunionElegido || !self) return; // lo eligió a mano: se respeta
    if (reunionBilingue) return; // ya se rindió y le pasó la decisión a la persona
    const ajenas = (meeting?.transcript ?? []).filter((l) => l.speakerId !== self.id).slice(-3);
    const distintas = ajenas.filter((l) => l.sourceLang && shortLang(l.sourceLang) !== shortLang(langReunion));
    if (distintas.length === 0) return;
    const corto = shortLang(distintas[distintas.length - 1].sourceLang);
    if (!distintas.every((l) => shortLang(l.sourceLang) === corto)) return;
    // DOS FRASES SEGUIDAS, O UNA SOLA PERO LARGA. Pedir siempre dos líneas se
    // rompió solo cuando el servidor empezó a PEGAR los fragmentos seguidos de
    // la misma persona en una sola línea: quien habla de corrido manda una
    // línea larga y ninguna segunda, así que el oído se quedaba en el idioma
    // equivocado toda la reunión (justo el «me hablaban en inglés y no me
    // funcionaba»). Una línea de ocho palabras o más en otro idioma es al
    // menos tanta evidencia como dos cortas.
    const palabras = distintas.reduce((n, l) => n + l.text.trim().split(/\s+/).filter(Boolean).length, 0);
    // El PRIMER cambio se hace con la evidencia de siempre: es el caso normal
    // («te uniste y la reunión es en inglés»). Volver a cambiar cuesta mucho
    // más -- tres frases seguidas o catorce palabras, y nunca antes de 45
    // segundos del cambio anterior -- porque un ida y vuelta es la firma de
    // una reunión bilingüe, no de un idioma nuevo.
    const yaCambioAntes = cambiosDeIdioma.current > 0;
    const minLineas = yaCambioAntes ? 3 : 2;
    const minPalabras = yaCambioAntes ? 14 : 8;
    if (distintas.length < minLineas && palabras < minPalabras) return;
    if (yaCambioAntes && Date.now() - ultimoCambioDeIdioma.current < 45_000) return;

    cambiosDeIdioma.current += 1;
    ultimoCambioDeIdioma.current = Date.now();
    // Al tercer cambio ya no es «cambió el idioma de la reunión»: es una
    // reunión en dos idiomas, y adivinar es peor que preguntar. Se deja de
    // cambiar solo y se lo dice una vez.
    if (cambiosDeIdioma.current >= 3) {
      setReunionBilingue(true);
      setAvisoIdiomaAjeno(
        "Acá se está hablando en más de un idioma, así que dejo de cambiar solo. Elegí en «Se habla» cuál querés que escuche."
      );
      return;
    }
    setIdiomaReunionAuto(codigoCompletoDe(corto));
    setAvisoIdiomaAjeno(`Los demás hablan en ${etiquetaDeIdioma(corto)}: ahora los escucho en ${etiquetaDeIdioma(corto)} (podés cambiarlo en «Se habla»).`);
  }, [meeting?.transcript, idiomaReunionElegido, langReunion, self, reunionBilingue]);
  useEffect(() => {
    if (!avisoIdiomaAjeno) return;
    const t = setTimeout(() => setAvisoIdiomaAjeno(null), 10_000);
    return () => clearTimeout(t);
  }, [avisoIdiomaAjeno]);

  // SALIR A PROPÓSITO. leaveMeeting() vacía el draft y react-router 7 pinta
  // la pantalla nueva en una transición: esta pantalla llega a re-renderizarse
  // SIN draft antes de irse, y la guardia de abajo ("no hay draft: afuera")
  // la mandaba a su propio destino pisando el real (el historial, la pantalla
  // de guardar). Se marca antes de irse y la guardia no actúa.
  const saliendoRef = useRef(false);
  const irse = (destino: string, opciones?: { state?: unknown }) => {
    saliendoRef.current = true;
    leaveMeeting();
    navigate(destino, { replace: true, ...opciones });
  };

  // No companion draft (e.g. someone refreshed this URL directly) -> there's
  // nothing to connect to; send them back to paste a link.
  useEffect(() => {
    if (saliendoRef.current) return;
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
  // El aparato de quien está en la reunión: sus instrucciones, no las de todos.
  const [aparato] = useState(detectarDispositivo);
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

  // EL MICRÓFONO NO SE PIDE POR ABRIR LA PANTALLA. Antes, al entrar, la
  // pantalla llamaba al cartel de permisos: en el iPad eso es un cartel del
  // sistema CADA VEZ («cada vez que abro la pantalla me tira si autorizo el
  // micrófono»), y encima prometía algo que el navegador no puede cumplir --
  // con la app en segundo plano no escucha nada. Ahora:
  //   - si el permiso YA está dado, el micrófono arranca solo y en silencio
  //     (la compu de siempre, sin cartel ni cambio);
  //   - si no, no se pide nada hasta que la persona lo pida con un botón, y
  //     la pantalla ofrece primero la escucha que NO depende de este aparato.
  const [permisoMic, setPermisoMic] = useState<"granted" | "denied" | "prompt" | "desconocido">(
    "desconocido",
  );
  useEffect(() => {
    let vivo = true;
    let estado: PermissionStatus | null = null;
    void (async () => {
      try {
        const p = await navigator.permissions?.query?.({ name: "microphone" as PermissionName });
        if (!p || !vivo) return;
        estado = p;
        setPermisoMic(p.state as "granted" | "denied" | "prompt");
        p.onchange = () => vivo && setPermisoMic(p.state as "granted" | "denied" | "prompt");
      } catch {
        // Safari de iPhone/iPad no sabe contestar esto: queda "desconocido",
        // que acá significa «no pidas nada hasta que te lo pidan».
      }
    })();
    return () => {
      vivo = false;
      if (estado) estado.onchange = null;
    };
  }, []);
  const [escuchaMicPedida, setEscuchaMicPedida] = useState(false);
  const micEncendido = permisoMic === "granted" || escuchaMicPedida;
  async function encenderMicrofono() {
    // El toque ES el gesto que el navegador exige para mostrar su cartel.
    const r = await pedirCartelDeMedios();
    if (r === "bloqueado") return; // el aviso de micrófono bloqueado lo explica
    setEscuchaMicPedida(true);
    setMicAttempt((n) => n + 1);
  }

  const { supported: captionsSupported, error: captionsError } = useSpeechRecognition({
    key: micAttempt,
    lang: spokenLang,
    active: connectionStatus === "connected" && !micTomadoPorGrabacion && micEncendido,
    onInterim: (text) => {
      setInterimCaption(text);
      // Y a la sala: si hay más gente con Unify abierto en esta reunión
      // externa, leen lo que estás diciendo mientras lo decís.
      sendInterim(text);
    },
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
  const captionsProblem = !captionsSupported
    ? (aparato.sistema === "ios"
        ? `Este navegador de ${aparato.corto} no puede transcribir voz. Para ver subtítulos, abrí Unify en Safari; si ya estás en Safari, mandá el bot y él transcribe todo desde el servidor.`
        : aparato.sistema === "android"
          ? "Este navegador no puede transcribir voz. Para ver subtítulos, abrí Unify en Chrome de Android."
          : "Este navegador no puede transcribir voz. Para ver subtítulos, abrí Unify en Chrome o Edge.")
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
  const escuchando =
    connectionStatus === "connected" && captionsOn && micEncendido && !captionsProblem;
  const [silencioLargo, setSilencioLargo] = useState(false);
  const ultimaVozRef = useRef(Date.now());
  const transcriptLargo = meeting?.transcript.length ?? 0;
  useEffect(() => {
    ultimaVozRef.current = Date.now();
    setSilencioLargo(false);
    // También cuenta lo que se está diciendo del otro lado (bot, extensión):
    // si están entrando voces, avisar "no llega ninguna voz" sería mentir.
  }, [interimCaption, interinoAjeno?.text, transcriptLargo, micAttempt]);
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
    ? `No está llegando ninguna voz al micrófono. Si la reunión corre en su app en este mismo aparato, el sistema le da el micrófono a la llamada y Unify no escucha nada. Salidas: dejá la reunión sonando en ALTAVOZ (sin auriculares) y esta pantalla al frente; ${comoVerLosDosALaVez(aparato)} O mandá el bot: graba y transcribe todo desde el servidor, sin depender de este micrófono.`
    : null;

  // EL IDIOMA EQUIVOCADO, detectado y corregible en un toque. La causa número
  // uno de "no entiende nada de lo que digo" es hablar en un idioma distinto
  // del configurado: el reconocimiento intenta encajar castellano en inglés y
  // salen palabras inventadas. El SERVIDOR ya detecta el idioma real de cada
  // frase (la IA correctora lo devuelve en sourceLang); acá se mira si las
  // últimas frases propias vienen en otro idioma y se ofrece el arreglo.
  const idiomaDetectado = (() => {
    if (!self) return null;
    const mias = (meeting?.transcript ?? []).filter((l) => l.speakerId === self.id).slice(-4);
    const distintas = mias.filter(
      (l) => l.sourceLang && shortLang(l.sourceLang) !== shortLang(spokenLang),
    );
    // Dos frases seguidas en otro idioma ya no son casualidad. O UNA SOLA
    // pero larga: el servidor pega los fragmentos seguidos de la misma
    // persona en una única línea, así que hablar de corrido da una línea
    // larga y ninguna segunda -- y el aviso no aparecía nunca.
    const palabras = distintas.reduce((n, l) => n + l.text.trim().split(/\s+/).filter(Boolean).length, 0);
    if (distintas.length === 0 || (distintas.length < 2 && palabras < 8)) return null;
    return shortLang(distintas[distintas.length - 1].sourceLang);
  })();
  const avisoIdioma = idiomaDetectado
    ? `Unify te está escuchando en ${etiquetaDeIdioma(spokenLang)}, pero hablás en ${etiquetaDeIdioma(idiomaDetectado)} — por eso las palabras salen mal.`
    : null;

  const { getTranslation, translationFailed } = useLineTranslations(meeting?.transcript ?? [], targetLang);

  // El bot, ofrecido DESDE ADENTRO. La escena donde más falta hace es esta:
  // la reunión corre en la app de este mismo teléfono, el sistema le da el
  // micrófono a la llamada y Unify no escucha nada. El bot no depende de
  // ningún micrófono de nadie -- entra desde el servidor, graba y transcribe.
  const botDeSala =
    draft?.mode === "companion" ? enlaceParaElBot(draft.embed, draft.externalKey) : null;
  // Zoom sin bot: con Realtime Media Streams en el servidor y una sala con
  // número, «mandar el bot» es que Zoom transmita la reunión (sin participante).
  const botSinParticipante =
    Boolean(botDeSala && botDeSala.platform === "zoom" && platforms?.zoomRtms) &&
    /^zoom:\d{9,12}$/.test(botDeSala?.roomKey ?? "");

  // El enlace de LA REUNIÓN DE VERDAD (la que vive en Meet/Zoom/Teams), para
  // poder volver a abrirla desde Ajustes cuando se cerró la pestaña.
  const enlaceDeLaReunion = (() => {
    const e = draft?.mode === "companion" ? (degraded ?? draft.embed) : null;
    if (!e) return null;
    if (e.kind === "meet") return e.meetLink;
    if (e.kind === "external") return e.joinLink;
    if (e.kind === "iframe") return e.joinLink;
    if (e.kind === "teams") return e.meetingLink;
    if (e.kind === "zoom") return e.joinLink ?? `https://zoom.us/j/${e.meetingNumber}`;
    if (e.kind === "jitsi") return `https://${e.domain ?? "meet.jit.si"}/${e.roomName}`;
    return null;
  })();

  // El botón de grabar. Donde no existe capturar la pantalla (iPhone/iPad)
  // grabar significa el MICRÓFONO: pedir pantalla ahí sólo daba un error. Al
  // encenderla, los subtítulos se pausan solos mientras dure (ver arriba).
  function toggleRecording() {
    if (recorder.status === "recording") recorder.stop();
    else if (recorder.status === "idle" || recorder.status === "error") {
      if (screenCaptureSupported) {
        // Grabar la pantalla no toca el micrófono: arranca derecho. `porGesto`
        // porque esto ES un botón: si la captura viene sin audio se pide el
        // micrófono para que la grabación no salga muda, y si tampoco hay se
        // avisa. (La grabación automática no lleva la marca: no puede abrir
        // el cartel de permisos por su cuenta.)
        void recorder.start({ porGesto: true });
      } else if (unSoloMicrofono) {
        // Donde el micrófono es de uno solo, PRIMERO se lo sueltan los
        // subtítulos y recién después lo pide el grabador. Pedirlo de una
        // (como hacía este botón) era caer en el mismo choque que dejaba
        // sin subtítulos Y con la grabación vacía. El reset deja el estado
        // en "idle" para que el traspaso arranque igual después de un fallo.
        recorder.reset();
        setCediendoMic(true);
      } else {
        void recorder.start({ audioOnly: true, porGesto: true });
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
    lang: langReunion,
    onFinal: (alternativas) =>
      sendTranscriptLine(alternativas, langReunion, { screen: true, origen: "reunion" }),
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
  // ¿Se está oyendo SÓLO tu voz? (Ninguna frase de otra persona y sin la
  // pista de la reunión.) Lo usan el aviso del escenario y la nota de
  // grabación, que si no decían lo mismo apilado.
  const soloTuVozAhora =
    !(meeting?.transcript ?? []).some((l) => l.speakerId !== self?.id) &&
    !(recorder.remoteAudioTrack && reunionSoportada);

  const avisoReunion =
    recorder.status === "recording" && recorder.kind === "screen" && !recorder.remoteAudioTrack
      ? "La grabación no trae el audio de la reunión, así que los demás no salen en los subtítulos: paren y vuelvan a grabar tildando «Compartir audio» al elegir la pestaña o pantalla."
      : capturaPosible && (chromeSinPista || (recorder.remoteAudioTrack && !reunionSoportada))
        ? "Para que los DEMÁS también salgan en los subtítulos, actualizá Chrome (este navegador no puede transcribir el audio de la reunión)."
        : null;

  // QUIÉN ESTÁ ESCUCHANDO, en una sola palabra. El orden es el de la verdad:
  // el servidor primero (escucha toda la reunión, aunque esta pantalla se
  // cierre), después este micrófono (que sólo oye con la app adelante), y si
  // no hay ninguno, «nadie» -- que es cuando la pantalla tiene que ofrecer
  // las salidas en vez de quedarse callada.
  const servidorEscuchando =
    faseBot === "adentro" ||
    faseBot === "escuchando" ||
    grabacionBot?.estado === "grabando" ||
    grabacionBot?.estado === "subiendo" ||
    grabacionBot?.estado === "guardada";
  // ¿Está entrando texto DE LA REUNIÓN por el puente? Es la extensión en la
  // pestaña de Meet, o alguien más con Unify abierto: no hace falta bot ni
  // este micrófono, y decir «nadie escucha» mientras aparecen frases era
  // mentir en la cara de la persona.
  const ultimaAjena = (meeting?.transcript ?? [])
    .filter((l) => l.speakerId !== self?.id)
    .slice(-1)[0];
  const entraTextoDeAfuera = Boolean(ultimaAjena && Date.now() - ultimaAjena.timestamp < 120_000);
  // EL BOTÓN DE LA ESCUCHA DEL SERVIDOR, uno solo, usado donde haga falta:
  // en la tarjeta de «no escucha nadie» y dentro del aviso de «sólo tu voz»
  // (en un teléfono es la única salida real).
  const botCompacto = botDeSala ? (
    <BotButton
      compacto
      url={botDeSala.url}
      roomKey={botDeSala.roomKey}
      platform={botDeSala.platform}
      // EL IDIOMA QUE VA A ESCUCHAR EL BOT es el de la reunión, no el tuyo: el
      // bot no oye tu micrófono, oye a los demás.
      lang={langReunion}
      sinParticipante={botSinParticipante}
    />
  ) : null;
  const modoDeEscucha: ModoDeEscucha =
    connectionStatus !== "connected"
      ? "conectando"
      : servidorEscuchando
        ? "servidor"
        : entraTextoDeAfuera
          ? "puente"
          : escuchando
            ? "microfono"
            : "nadie";
  const detalleDelServidor =
    grabacionBot?.estado === "grabando"
      ? "Está grabando: al terminar queda en tu historial."
      : grabacionBot?.estado === "subiendo"
        ? "Guardando la grabación…"
        : grabacionBot?.estado === "guardada"
          ? "La grabación ya quedó en tu historial."
          : grabacionBot?.estado === "fallo"
            ? `No se pudo grabar${grabacionBot.detalle ? `: ${grabacionBot.detalle}` : "."}`
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
    // En el flujo de la APP DE WINDOWS el video ya lo graba el grabador
    // silencioso de la propia app (pantalla + audio del sistema, sin
    // selector): duplicarlo acá daría DOS videos del mismo rato en el
    // historial. La barra se queda con lo suyo: subtítulos, traducción e IA.
    if (escritorioRef.current) return;
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
  // SALIR SALE. «El botón de salir de la reunión no anda» era esto: si había
  // una grabación subiendo, tocar Salir dejaba a la persona hasta TREINTA
  // segundos mirando un cartel, sin entender por qué seguía adentro. Y la
  // espera no hacía falta: el archivo se guarda en el navegador ANTES de
  // intentar subirlo (ver recordingVault), así que irse en medio de la subida
  // no pierde nada -- se reintenta sola al volver a abrir Unify.
  // Lo único que sí hay que esperar es que el archivo TERMINE de armarse, que
  // es cosa de un segundo, y con un tope corto por las dudas.
  function exitWhenSaved(exit: () => void) {
    const guardando =
      recorder.status === "recording" ||
      recorder.status === "processing" ||
      recorder.uploadStatus === "uploading";
    if (!guardando) {
      exit();
      return;
    }
    if (recorder.status === "recording") recorder.stop();
    pendingExitRef.current = exit;
    // OCHO SEGUNDOS, NO TREINTA. Se espera lo justo para que el archivo
    // termine de armarse y la subida arranque; pasado eso se sale igual,
    // porque el archivo ya está guardado en este navegador y se reintenta
    // solo al volver a abrir Unify. Con treinta, quien tocaba «Salir» se
    // quedaba medio minuto mirando un cartel sin entender por qué seguía
    // adentro -- que es como se ve un botón que «no anda».
    savingDeadlineRef.current = Date.now() + 8000;
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

  // Sin nada que guardar (ni una frase, ni grabación) no se pregunta si se
  // guarda: salir es salir. Pasaba al fallar la entrada a Zoom: la persona
  // tocaba «Salir» y le aparecía «¿Guardar esta reunión?» de una reunión vacía.
  const hayAlgoQueGuardar = () =>
    (meeting?.transcript.length ?? 0) > 0 ||
    recorder.status === "recording" ||
    recorder.status === "processing" ||
    recorder.status === "done" ||
    recorder.uploadStatus === "uploading" ||
    recorder.uploadStatus === "uploaded";

  function handleLeave() {
    if (!user && meeting?.dbId && hayAlgoQueGuardar()) {
      setPendingLeave(meeting.dbId);
      return;
    }
    exitWhenSaved(() => {
      irse("/");
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
  // Antes esto era un flag de sessionStorage que se CONSUMÍA al montar: un
  // remontaje del componente lo perdía y la barra arrancaba su propia
  // grabación en modo escritorio (video duplicado). En el draft no se pierde,
  // y una reunión externa común (draft nuevo, sin la marca) no lo hereda.
  const escritorioRef = useRef(draft?.mode === "companion" && draft.escritorio === true);
  const finishFromDesktopRef = useRef<() => void>(() => {});
  finishFromDesktopRef.current = () => {
    if (recorder.status === "recording") recorder.stop();
    const dbId = meeting?.dbId ?? null;
    if (!user && dbId && hayAlgoQueGuardar()) {
      setPendingLeave(dbId);
      return;
    }
    exitWhenSaved(() => {
      irse(user && dbId ? `/historial/${dbId}` : "/");
    });
  };
  useEffect(() => {
    if (!escritorioRef.current || connectionStatus !== "connected") return;
    let terminadas = 0;
    let hecho = false;
    // Gracia inicial: en los primeros segundos el puente puede estar
    // levantándose (o la app ocupada); despedirse en ese ratito cortaría una
    // grabación recién nacida. Después de la gracia, dos lecturas de
    // "terminó" seguidas y recién ahí se cierra todo.
    const nacido = Date.now();
    const GRACIA_PUENTE_MS = 15_000;
    const timer = setInterval(async () => {
      if (hecho || Date.now() - nacido < GRACIA_PUENTE_MS) return;
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
      // Más grande de entrada y con la letra que ESCALA con la ventana, más
      // A− / A+ propios que se recuerdan (ver lib/flotantes): para leer de
      // lejos, con la traducción como lectura principal y el original debajo.
      const win = await api.requestWindow({ width: 520, height: 230 });
      prepararVentanaFlotante(win);
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
    // El doble de resolución que antes: en una pantalla retina el texto
    // salía borroso, y flotante se lee de lejos.
    canvas.width = 1200;
    canvas.height = 400;
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
      // Grande y legible. Era un cuadradito de 176 px en la esquina: cuando
      // el navegador no deja flotar de verdad (Safari en iPad), eso es lo
      // único que queda, y así no se lee nada. Ahora ocupa el ancho de la
      // pantalla, arriba del dock, con el mismo tamaño de letra que se lee
      // de lejos.
      video.style.cssText =
        "position:fixed;left:50%;transform:translateX(-50%);bottom:88px;" +
        "width:min(94vw,640px);aspect-ratio:3/1;border-radius:16px;" +
        "border:1px solid #dbe7fb;box-shadow:0 10px 30px rgba(15,23,42,.22);background:#0b1020;" +
        "object-fit:contain;pointer-events:none;z-index:60";
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
        "Este navegador no deja poner los subtítulos encima de otras apps. Te los dejamos grandes acá abajo: en el iPad podés abrir Meet en Split View al lado, o dejar Meet en su ventanita flotante y Unify de fondo.",
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
  // Las frases para los flotantes (ventanita o video): la traducción como
  // lectura principal con el original debajo, y lo que estás diciendo ahora.
  function frasesFlotantes(): FraseFlotante[] {
    const frases: FraseFlotante[] = transcriptPip.slice(-3).map((l) => {
      const trad = getTranslation(l);
      return trad && trad !== l.text
        ? { quien: l.speakerName, texto: trad, original: l.text }
        : { quien: l.speakerName, texto: l.text };
    });
    if (captionsOn && interimCaption) {
      frases.push({ quien: draft?.name || "Vos", texto: interimCaption, interina: true });
    } else if (interinoUtil) {
      // Lo que se está diciendo en la reunión, mientras se dice.
      frases.push({ quien: interinoUtil.speaker, texto: interinoUtil.text, interina: true });
    }
    return frases;
  }
  function pintarCanvasPip(canvas: HTMLCanvasElement) {
    pintarFlotantesEnCanvas(canvas, frasesFlotantes());
  }
  // Cada frase nueva (o su traducción, que llega después) repinta la ventana.
  // Siempre por textContent, nunca innerHTML: lo dicho en la reunión es texto.
  const transcriptPip = meeting?.transcript ?? [];
  useEffect(() => {
    if (videoPipRef.current) pintarCanvasPip(videoPipRef.current.canvas);
    const win = pipRef.current;
    if (!pipAbierto || !win) return;
    try {
      pintarFlotantesEnDocumento(win.document, frasesFlotantes());
    } catch {
      /* la ventanita se cerró en el medio: el próximo repintado la ignora */
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
      irse("/ingresar", { state: { claimMeetingId: dbId } });
    });
  }
  function skipSaveMeeting() {
    const dbId = pendingLeave!;
    const joinCode = meeting?.id ?? "";
    setPendingLeave(null);
    exitWhenSaved(() => {
      setUnsavedMeeting({ dbId, joinCode, endedAt: Date.now() });
      irse("/");
    });
  }

  if (!draft || draft.mode !== "companion") return null;

  const captionLines = captionsOn
    ? recentCaptionEntries(meeting?.transcript ?? [], getTranslation)
    : [];
  const participantCount = meeting?.participants.length ?? 0;
  // Con Meet o una reunión externa la llamada vive en otra ventana y el
  // escenario grande ocupa el panel: las burbujas flotantes sobran.
  const embedKind = (degraded ?? draft.embed).kind;
  const escenarioALaVista = embedKind === "meet" || embedKind === "external";
  // Últimas frases con su traducción, para la pantalla grande de subtítulos.
  const stageLines = (meeting?.transcript ?? []).slice(-8).map((l) => ({
    id: l.id,
    speakerId: l.speakerId,
    speakerName: l.speakerName,
    text: l.text,
    translated: getTranslation(l),
  }));
  // Lo que se está diciendo AHORA en la reunión de afuera. Si resulta ser un
  // pedazo de una frase que YA está en pantalla (el interino llegó tarde,
  // después de la frase terminada), no se repite: sería leer dos veces lo
  // mismo durante varios segundos.
  const interinoUtil = (() => {
    if (!interinoAjeno) return null;
    const suelto = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
    const suya = [...stageLines].reverse().find((l) => l.speakerName === interinoAjeno.speaker);
    return suya && suelto(suya.text).includes(suelto(interinoAjeno.text)) ? null : interinoAjeno;
  })();
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
    // El estado de la conexión, legible por fuera: las pruebas (y cualquiera
    // que mire el DOM) preguntaban por un texto de la interfaz —«Companion
    // activo»— que vivía en una barra que ya no existe. Un dato es un dato;
    // el texto puede cambiar cuando la pantalla mejora.
    <div className="flex h-dvh flex-col bg-ink-950" data-conexion={connectionStatus}>
      {/* LA CABECERA: de qué reunión se trata, cómo salir, y los dos idiomas.
          Nada más. Todo lo demás está abajo o en Ajustes. */}
      <BarraDeReunion
        sala={draft.roomLabel}
        personas={participantCount}
        onSalir={handleLeave}
        onInvitar={() => togglePanel("ajustes")}
        leesEn={targetLangChoice}
        onLeesEn={setTargetLangChoice}
        autoLabel={etiquetaDeIdioma(spokenLang)}
        hablanEn={idiomaReunionElegido}
        onHablanEn={elegirIdiomaReunion}
        hablanEnEfectivo={etiquetaDeIdioma(langReunion)}
        compacto={compacto}
      />

      {/* LO QUE UNIFY ACABA DE DECIDIR, EN SU PROPIO RENGLÓN. Estos dos avisos
          flotaban (`fixed top-24` y `top-28`) y caían justo sobre la barra:
          en una reunión real el cartel del idioma quedó clavado ENCIMA del
          selector de «Traducir», que es lo que la persona iba a tocar. Un
          aviso que tapa el control que resuelve el problema no es un aviso.
          Acá ocupan su renglón y empujan al resto, como todo lo demás. */}
      {(avisoIdiomaAjeno || flotantesAviso) && (
        <div className="flex flex-col gap-1.5 border-b border-ink-800 bg-ink-900/60 px-4 py-2">
          {avisoIdiomaAjeno && (
            <p role="status" className="text-center text-sm font-medium text-strong">
              {avisoIdiomaAjeno}
            </p>
          )}
          {flotantesAviso && (
            <p className="text-center text-xs leading-snug text-warn">{flotantesAviso}</p>
          )}
        </div>
      )}

      {/* QUIÉN ESTÁ ESCUCHANDO. Una sola pieza en lugar de las tres franjas de
          texto que había (aviso amarillo + nota gris + consejo), que entre
          todas no contestaban lo único que importa: si ahora mismo se está
          transcribiendo, y si no, qué tocar. */}
      <EstadoDeEscucha
        modo={modoDeEscucha}
        problema={captionsProblem ?? avisoIdioma ?? avisoSilencio ?? avisoReunion}
        detalleServidor={detalleDelServidor}
        // La app de escritorio graba el video por su cuenta: si esta pantalla
        // no lo dijera, la persona creería que no se está grabando nada.
        aclaracion={
          escritorioRef.current && recorder.status === "idle"
            ? "El video lo está grabando la app de Unify (la pantalla, con el audio del sistema): al cortar la reunión aparece solo en tu historial."
            : null
        }
        micDisponible={captionsSupported && !micBloqueado}
        onEncenderMicrofono={escuchaMicPedida ? null : () => void encenderMicrofono()}
        accionServidor={botCompacto}
        nota={
          soloTuVozAhora ? (
            <AvisoSoloTuVoz
              aparato={aparato}
              accionEscucharTodos={
                screenCaptureSupported &&
                draft?.mode === "companion" &&
                (draft.embed.kind === "meet" || draft.embed.kind === "external") &&
                !(recorder.status === "recording" && recorder.kind === "screen")
                  ? () => {
                      // El clic ES el gesto que getDisplayMedia exige.
                      if (recorder.status === "recording") recorder.stop();
                      void recorder.start({ porGesto: true });
                    }
                  : null
              }
              // La salida del servidor va también acá, salvo cuando la tarjeta
              // de arriba ya la está ofreciendo (si no, el mismo botón dos
              // veces). En un teléfono ES la única salida: sin esto, el aviso
              // explicaba el problema y no daba con qué arreglarlo.
              accionBot={modoDeEscucha === "nadie" ? null : botCompacto}
              sinAudioCompartido={
                recorder.status === "recording" && recorder.kind === "screen" && !recorder.remoteAudioTrack
              }
              navegadorSinPista={
                capturaPosible && (chromeSinPista || Boolean(recorder.remoteAudioTrack && !reunionSoportada))
              }
              esMeet={draft?.mode === "companion" && draft.embed.kind === "meet"}
            />
          ) : null
        }
        compacto={compacto}
      />

<RecordingBanner
        status={recorder.status}
        uploadStatus={recorder.uploadStatus}
        error={recorder.error}
        resultUrl={recorder.resultUrl}
        resultType={recorder.resultType}
        kind={recorder.kind}
        selfCapture={recorder.selfCapture}
        avisoSonido={recorder.avisoSonido}
        // Pasar de sólo audio a pantalla necesita un clic: getDisplayMedia
        // exige un gesto del usuario, y este botón es ese gesto. En el
        // celular no existe capturar pantalla: ahí el botón ni aparece.
        onAddScreen={
          typeof navigator.mediaDevices?.getDisplayMedia === "function"
            ? () => {
                recorder.stop();
                void recorder.start({ porGesto: true });
              }
            : undefined
        }
        // Detener, DONDE SE VE que está grabando. Antes era un iconito en la
        // barra de abajo, lejos del cartel: quien quería parar tenía que
        // adivinar cuál de seis botones era.
        onStop={recording ? () => recorder.stop() : undefined}
        onDismiss={recorder.reset}
      />

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
              compacto={compacto}
              embed={degraded ?? draft.embed}
              displayName={draft.name}
              onLeave={handleLeave}
              onDegrade={(label, joinLink, nota, abrirYa) => {
                // Si viene de un clic, la reunión se abre en su app YA (fuera
                // de un gesto el navegador lo bloquea); si no, el panel deja
                // el botón «Abrir en Zoom» a la vista.
                if (abrirYa) abrirVentanaReunion(joinLink);
                setDegraded({ kind: "external", label, joinLink, nota });
              }}
              subtitleStage={
                <CompanionSubtitleStage
                  lines={stageLines}
                  roleFor={roleFor}
                  avatarFor={avatarFor}
                  interim={(captionsOn ? interimCaption : null) ?? interinoUtil?.text ?? null}
                  interimSpeaker={
                    captionsOn && interimCaption ? draft.name || "Vos" : (interinoUtil?.speaker ?? "La reunión")
                  }
                  interimAvatarUrl={user?.avatarUrl ?? null}
                  compacto={compacto}
                />
              }
            />
          )}

          {/* Las burbujas sobre el video sólo cuando HAY video acá adentro
              (Jitsi, Zoom, Teams, iframe). Con Meet o una reunión externa el
              escenario grande ya muestra las mismas frases con su traducción,
              y las burbujas le tapaban las últimas líneas. */}
          {!escenarioALaVista && (
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
          )}

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

        {activePanel === "ajustes" && (
          <SidePanel title="Ajustes de la reunión" onClose={() => setActivePanel(null)}>
            <AjustesDeReunion
              invitarUrl={inviteUrl}
              onRoles={() => setActivePanel("roles")}
              grabando={recording}
              onGrabar={toggleRecording}
              puedeGrabar={Boolean(draft)}
              textoGrabar={
                screenCaptureSupported
                  ? "Grabar la reunión (pantalla y audio)"
                  : "Grabar el audio por el micrófono"
              }
              notaGrabar={
                grabacionCedida
                  ? `En ${aparato.corto} el micrófono es de una sola cosa a la vez: mientras grabás, los subtítulos se pausan. Si querés las dos cosas, que escuche Unify desde el servidor.`
                  : null
              }
              abrir={
                enlaceDeLaReunion
                  ? {
                      etiqueta: draft.roomLabel || "la reunión",
                      alAbrir: () => abrirVentanaReunion(enlaceDeLaReunion),
                    }
                  : null
              }
            />
          </SidePanel>
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

      {/* LA BARRA DE ABAJO. Cada control tiene la FORMA de lo que es (ver
          BarraDeAcciones): interruptor = queda prendido o apagado; cápsula =
          elegí uno de estos paneles; acción suelta al otro lado de una línea
          = esto toca la reunión de verdad. Antes eran cinco círculos grises
          idénticos, con «cortar la reunión» pegado a «ver la transcripción».
          Salir sigue arriba, con su nombre escrito. */}
      <Barra>
        <Interruptor
          // El nombre dice qué pasa AL TOCARLO, no en qué estado está: es lo
          // que necesita saber quien lo va a apretar.
          label={captionsOn ? "Pausar los subtítulos en vivo" : "Reanudar los subtítulos en vivo"}
          nombre={captionsOn ? "Subtítulos" : "Pausados"}
          encendido={captionsOn}
          onClick={() => setCaptionsOn((v) => !v)}
        >
          <CaptionsIcon className="h-5 w-5" />
        </Interruptor>

        {pipSoportado && (
          <Interruptor
            label={
              pipAbierto
                ? "Subtítulos flotantes — cerrar la ventanita que queda encima de las demás apps"
                : "Subtítulos flotantes — una ventanita con los subtítulos que queda SIEMPRE encima de las demás apps"
            }
            nombre="Flotantes"
            encendido={pipAbierto}
            onClick={() => void toggleFlotantes()}
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" aria-hidden>
              <rect x="1.5" y="3.5" width="17" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
              <rect x="9.5" y="9.5" width="7" height="5" rx="1.2" fill="currentColor" />
            </svg>
          </Interruptor>
        )}

        <Selector
          opciones={[
            {
              clave: "transcript",
              label: "Ver la transcripción completa y traducciones",
              nombre: "Transcripción",
              abierto: activePanel === "transcript",
              onClick: () => togglePanel("transcript"),
              icono: <TranscriptIcon className="h-5 w-5" />,
            },
            {
              clave: "ai",
              label: "Abrir el asistente de IA de la reunión",
              nombre: "IA",
              abierto: activePanel === "ai",
              onClick: () => togglePanel("ai"),
              icono: <SparklesIcon className="h-5 w-5" />,
            },
            {
              clave: "ajustes",
              label: "Ajustes de esta reunión: invitar, roles, grabar, texto grande",
              nombre: "Ajustes",
              abierto: activePanel === "ajustes",
              onClick: () => togglePanel("ajustes"),
              icono: <ShieldIcon className="h-5 w-5" />,
            },
          ]}
        />

        {/* Del otro lado de la línea, lo que TOCA la reunión. Y sólo con la
            extensión en la pestaña de Meet, que es quien puede apretar de
            verdad los botones de Google: sin ella no aparecen, en vez de
            ofrecer botones que no harían nada. */}
        {extensionViva && (
          <>
            <Separador />
            <Accion
              label={meetState?.micMuted ? "Activar tu micrófono en Meet" : "Silenciar tu micrófono en Meet"}
              nombre={meetState?.micMuted ? "Activar mic" : "Silenciar"}
              onClick={() => void ordenar("mic-toggle")}
            >
              {meetState?.micMuted ? <MicOffIcon className="h-5 w-5" /> : <MicIcon className="h-5 w-5" />}
            </Accion>
            <Accion
              label="Cortar la reunión en Meet"
              nombre="Cortar"
              peligro
              onClick={() => void ordenar("colgar")}
            >
              <PhoneOffIcon className="h-5 w-5" />
            </Accion>
          </>
        )}
      </Barra>
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
                  ? "Terminando de armar el archivo…"
                  : "Mandándola a tu historial…"}
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
              La grabación ya queda guardada en este dispositivo: si la subida no llega, se
              reintenta sola la próxima vez que abras Unify.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
