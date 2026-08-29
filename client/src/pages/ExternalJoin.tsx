import { FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import BotButton from "../components/BotButton";
import Button from "../components/Button";
import Logo from "../components/Logo";
import { useAuth } from "../context/AuthContext";
import { useMeeting } from "../context/MeetingContext";
import { fetchPlatformConfig, PlatformConfig } from "../lib/api";
import {
  autoRecordEnabled,
  requestDisplayStreamOnGesture,
  setAutoRecordEnabled,
  stashDisplayStream,
} from "../lib/autoRecord";
import { LANGUAGES, idiomaDelDispositivo, recordarIdioma } from "../lib/languages";
import {
  DetectedMeeting,
  detectMeetingPlatform,
  externalFallbackKey,
  extractPasscode,
  impersonatedDomain,
  PLATFORM_REGISTRY,
} from "../lib/meetingPlatforms";
import { esIOS } from "../lib/screenCapture";
import { cardClass, inputClass, labelClass, nameInputProps, urlInputProps } from "../lib/ui";
import { abrirVentanaReunion } from "../lib/ventanaReunion";
import { CompanionEmbed } from "../types";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

// Entry point for joining a meeting hosted on ANOTHER platform (Zoom, Meet,
// Jitsi...). Paste a link -> we detect the platform and route it: Zoom and
// Jitsi run embedded (with Unify's transcript/AI layer on top), our own
// links jump to the native join flow, and everything else shows an honest
// "recognized, here's how to open it" card (with the real join integration
// filled in per-platform over the coming phases).
// Traduce un enlace reconocido a "en qué sala de Unify entra y qué panel se
// muestra". Una sola función para las dos entradas (el botón y el enlace
// profundo de la extensión), así no pueden divergir.
//
// La clave de sala SIEMPRE sale de `roomKey` (la identidad de la reunión),
// nunca de la URL completa: los parámetros de una invitación son distintos
// para cada persona, y usarlos partiría en dos salas a gente que abrió la
// misma reunión.
function companionEmbedFor(
  target: DetectedMeeting,
  passcode: string
): { key: string; label: string; embed: CompanionEmbed } | null {
  const { platform, meetingId, url, roomKey } = target;

  if (platform === "jitsi" && meetingId && roomKey) {
    const server = target.jitsiDomain ?? "meet.jit.si";
    return {
      key: roomKey,
      // El dominio se muestra sólo cuando NO es el público: en una instalación
      // propia o en 8x8 saber a qué servidor entraste importa.
      label: server === "meet.jit.si" ? `Jitsi · ${meetingId}` : `Jitsi (${server}) · ${meetingId}`,
      embed: { kind: "jitsi", roomName: meetingId, domain: server },
    };
  }
  // Las que se dejan embeber por iframe (Whereby, Element Call).
  if (target.embedUrl && url && roomKey) {
    const label = PLATFORM_REGISTRY[platform].label;
    return {
      key: roomKey,
      label: meetingId ? `${label} · ${meetingId}` : label,
      embed: { kind: "iframe", label, embedUrl: target.embedUrl, joinLink: url },
    };
  }
  if (platform === "zoom" && meetingId && roomKey) {
    return {
      key: roomKey,
      label: `Zoom · ${meetingId}`,
      // The plain passcode the user typed (if any). We deliberately ignore
      // the link's `pwd`: it's an encrypted token the Meeting SDK rejects.
      embed: { kind: "zoom", meetingNumber: meetingId, passcode: passcode.trim() || undefined },
    };
  }
  if (platform === "google-meet" && meetingId && url && roomKey) {
    return {
      key: roomKey,
      label: `Google Meet · ${meetingId}`,
      embed: { kind: "meet", meetCode: meetingId, meetLink: url },
    };
  }
  if (platform === "microsoft-teams" && url && roomKey) {
    // Teams personal ("Teams for life") no se puede embeber nunca: Microsoft
    // bloquea el interop de ACS. Va derecho a companion, sin intentar un SDK
    // que va a fallar y sin necesitar credenciales en el servidor.
    if (target.personal) {
      return {
        key: roomKey,
        label: "Microsoft Teams",
        embed: { kind: "external", label: "Teams", joinLink: url },
      };
    }
    return { key: roomKey, label: "Microsoft Teams", embed: { kind: "teams", meetingLink: url } };
  }
  // Reconocida pero sin embed posible (Webex, Skype, GoTo, Chime...): companion.
  if (url && roomKey) {
    return {
      key: roomKey,
      label: PLATFORM_REGISTRY[platform].label,
      embed: { kind: "external", label: PLATFORM_REGISTRY[platform].label, joinLink: url },
    };
  }
  // No la reconocemos por nombre, pero es un enlace de verdad: la capa de
  // Unify no depende de la otra plataforma, así que igual se puede acompañar.
  // La sala sale del origen + path (nunca del query, que trae tokens propios).
  if (url) {
    const key = externalFallbackKey(url);
    if (!key) return null;
    let host = "";
    try { host = new URL(url).host.replace(/^www\./, ""); } catch { /* imposible: key existe */ }
    return {
      key,
      label: host,
      embed: { kind: "external", label: host, joinLink: url },
    };
  }
  return null;
}

export default function ExternalJoin() {
  useDocumentTitle("Unirme a una reunión");
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { startCompanionDraft, prewarm } = useMeeting();
  // Warm the backend/socket while they paste the link, so joining is instant.
  useEffect(() => prewarm(), [prewarm]);
  const [link, setLink] = useState("");
  // Remembered across sessions so the from-Meet flow (extension button) can
  // skip straight into the companion without retyping anything.
  const [name, setName] = useState(() => localStorage.getItem("unify_external_name") ?? "");
  // Arranca en el idioma del APARATO (o el último elegido): también gobierna
  // el deep link de la app de escritorio, que entra sin formularios.
  const [language, setLanguage] = useState(idiomaDelDispositivo);
  const [passcode, setPasscode] = useState("");
  const [detected, setDetected] = useState<DetectedMeeting | null>(null);
  // Which platforms the server can actually embed (Zoom/Teams need credentials),
  // so we can be honest before the user tries instead of failing inside the embed.
  const [platforms, setPlatforms] = useState<PlatformConfig | null>(null);
  useEffect(() => {
    fetchPlatformConfig().then(setPlatforms);
  }, []);

  // Reconoce el enlace apenas se pega o se escribe: apretar "Detectar" era un
  // paso extra que no aportaba nada -- ya sabemos de qué plataforma es en
  // cuanto el texto está completo. Si el pegado trae la contraseña, se carga
  // sola. El botón sigue existiendo para quien lo busque.
  function handleLink(raw: string) {
    setLink(raw);
    const result = detectMeetingPlatform(raw, { selfHosts: [window.location.hostname] });
    setDetected(result.platform === "unknown" && raw.trim().length < 12 ? null : result);
    const found = extractPasscode(raw);
    if (found) setPasscode(found);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = detectMeetingPlatform(link, { selfHosts: [window.location.hostname] });

    // Our own invite links don't need any of this -- send them through the
    // existing native join flow (which also collects the spoken language).
    if (result.platform === "encuentro" && result.meetingId) {
      navigate(`/unirse/${result.meetingId}`);
      return;
    }
    setDetected(result);
  }

  // Starts a companion session for a detected meeting: builds the shared
  // backend room key (deterministic from the meeting's own id, so everyone who
  // opens the same link lands together) and the per-platform embed descriptor,
  // then jumps into the overlay page.
  //
  // `displayStream` es la captura de pantalla que pudimos pedir DURANTE el clic
  // (ver joinWithAutoRecord): se la pasamos a la pantalla de reunión para que
  // la grabación arranque sola. El navegador no deja pedirla más tarde.
  function joinDetected(target: DetectedMeeting) {
    if (name.trim()) localStorage.setItem("unify_external_name", name.trim());
    const base = { name: name.trim() || "Invitado", language };
    const embed = companionEmbedFor(target, passcode);
    if (!embed) return;
    startCompanionDraft({
      ...base,
      externalKey: embed.key,
      roomLabel: embed.label,
      embed: embed.embed,
    });
    navigate("/externa/reunion");
  }

  // Pide la captura de pantalla aprovechando ESTE clic (el navegador exige un
  // gesto: fuera de él, getDisplayMedia se rechaza siempre) y recién después
  // entra a la reunión, que la usa para empezar a grabar sola. Si la persona
  // cancela el selector, no pasa nada: adentro la grabación arranca igual en
  // modo sólo audio.
  const [preparingRecording, setPreparingRecording] = useState(false);
  // La reunión REAL se abre acá, con el MISMO clic de "Unirme" (tras un await
  // el navegador ya lo trataría como popup no pedido): en el celular salta a
  // la app de Meet/la plataforma; en compu abre su pestaña. Unify queda en
  // ESTA pestaña como capa de subtítulos. Sólo para las plataformas que no
  // pueden vivir embebidas acá (Meet y las "external"): abrir otra copia de
  // una embebible sería duplicar la reunión.
  function abrirReunionRealSiHaceFalta(target: DetectedMeeting) {
    const info = companionEmbedFor(target, passcode);
    if (!info) return;
    const e = info.embed;
    const link = e.kind === "meet" ? e.meetLink : e.kind === "external" ? e.joinLink : null;
    if (link) abrirVentanaReunion(link);
  }
  async function joinWithAutoRecord(target: DetectedMeeting) {
    abrirReunionRealSiHaceFalta(target);
    if (!autoRecordEnabled()) {
      joinDetected(target);
      return;
    }
    setPreparingRecording(true);
    try {
      const stream = await requestDisplayStreamOnGesture();
      if (stream) stashDisplayStream(stream);
    } finally {
      setPreparingRecording(false);
    }
    joinDetected(target);
  }

  // Deep link from the browser extension's "Grabar con Unify" button inside
  // Meet: /externa?link=<meet url>&rec=1. Prefill + detect immediately, and
  // with a remembered name jump straight into the companion (rec=1 leaves a
  // one-shot flag that the companion page turns into a "ready to record"
  // hint), so the whole flow from Meet is a single click.
  const [searchParams] = useSearchParams();
  const deepLinkRan = useRef(false);
  useEffect(() => {
    if (deepLinkRan.current) return;
    // Deep link de la APP DE ESCRITORIO: detectó que la app de Zoom entró a
    // una reunión. Acá NO hay enlace que detectar (la persona se unió directo
    // en Zoom), así que se entra derecho al companion con la sala que manda la
    // app -- un solo movimiento, sin escribir nada. `sala` viene generada por
    // la app (estable mientras dura esa reunión, por si esta pestaña se
    // recarga); si faltara, se inventa una acá.
    if (searchParams.get("origen") === "escritorio") {
      // Con sesión iniciada, la persona entra con SU nombre de cuenta -- por
      // eso se espera a que la autenticación resuelva (es un fetch corto)
      // antes de armar el draft; el efecto se re-corre cuando termina.
      if (authLoading) return;
      deepLinkRan.current = true;
      const cruda = searchParams.get("sala") ?? "";
      const sala =
        cruda.replace(/[^a-z0-9-]/gi, "").slice(0, 48) ||
        `zoom-${Date.now().toString(36)}`;
      // La barra acompañante arranca grabando sola y sabe que la vigila el
      // puente local de la app (ver ExternalMeeting).
      sessionStorage.setItem("unify_autorec", "1");
      sessionStorage.setItem("unify_escritorio", "1");
      const savedName = (localStorage.getItem("unify_external_name") ?? "").trim();
      startCompanionDraft({
        name: savedName || user?.name || "Invitado",
        language,
        externalKey: `escritorio-${sala}`,
        roomLabel: "Zoom (app de escritorio)",
        embed: { kind: "external", label: "Zoom", joinLink: "https://zoom.us/join" },
      });
      navigate("/externa/reunion", { replace: true });
      return;
    }
    // `link` es el deep link de la extensión. `url`/`text`/`title` son lo que
    // manda el share_target de la PWA (compartís el enlace de Zoom desde
    // WhatsApp -> Unify): muchas apps ponen el enlace en `text`, no en `url`,
    // así que se miran los tres. El detector ya sabe pescar un enlace metido
    // dentro de una invitación entera pegada tal cual.
    const prefill =
      searchParams.get("link") ??
      searchParams.get("url") ??
      searchParams.get("text") ??
      searchParams.get("title");
    if (!prefill) return;
    deepLinkRan.current = true;
    setLink(prefill);
    if (searchParams.get("rec") === "1") sessionStorage.setItem("unify_autorec", "1");
    const result = detectMeetingPlatform(prefill, { selfHosts: [window.location.hostname] });
    setDetected(result);
    const savedName = (localStorage.getItem("unify_external_name") ?? "").trim();
    if (savedName && result.platform === "google-meet" && result.meetingId && result.url) {
      // Entrada de un clic desde la extensión. La grabación NO se pide acá:
      // este `useEffect` no es un gesto del usuario, así que el navegador
      // rechazaría getDisplayMedia; adentro arranca sola en modo audio.
      joinDetected(result);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, authLoading]);

  return (
    <div className="flex min-h-[calc(100dvh-3.25rem)] flex-col items-center bg-ink-950 px-6 py-10">
      <div className="w-full max-w-md">
        <Logo className="mb-8" />
        <div className={cardClass}>
          <h1 className="text-2xl font-bold text-strong">Unirme a una reunión externa</h1>
          <p className="mt-1 text-sm text-ink-300">
            ¿Te mandaron un link? Pegalo acá. La plataforma la reconocemos solos.
          </p>

          <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
            <div>
              <label className={labelClass} htmlFor="link">
                Enlace de la reunión
              </label>
              <input
                id="link"
                className={inputClass}
                placeholder="https://…"
                {...urlInputProps}
                value={link}
                onChange={(e) => handleLink(e.target.value)}
                required
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="name">
                Tu nombre
              </label>
              <input
                id="name"
                className={inputClass}
                placeholder="Ej: Diego"
                {...nameInputProps}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="language">
                Idioma en el que vas a hablar
              </label>
              <select
                id="language"
                className={inputClass}
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  recordarIdioma(e.target.value);
                }}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-ink-400">
                Decinos en qué idioma hablás y te armamos los subtítulos y la traducción en vivo.
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="button" variant="ghost" className="flex-1" onClick={() => navigate("/")}>
                Volver
              </Button>
              <Button type="submit" className="flex-1" disabled={!link.trim()}>
                Detectar
              </Button>
            </div>
          </form>

          {detected && (
            <DetectionResult
              detected={detected}
              platforms={platforms}
              passcode={passcode}
              preparing={preparingRecording}
              onPasscodeChange={setPasscode}
              onJoinEmbed={() => void joinWithAutoRecord(detected)}
              lang={language}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DetectionResult({
  detected,
  platforms,
  passcode,
  preparing,
  onPasscodeChange,
  onJoinEmbed,
  lang,
}: {
  detected: DetectedMeeting;
  platforms: PlatformConfig | null;
  passcode: string;
  preparing: boolean;
  onPasscodeChange: (value: string) => void;
  onJoinEmbed: () => void;
  /** El idioma que la persona dijo que se habla: el OÍDO del bot. */
  lang: string;
}) {
  const { platform, info, url, meetingId, roomKey } = detected;

  // Zoom/Teams need server credentials; if the server says they're off, don't
  // offer an in-app join that would just error -- point to opening it directly.
  // (Unknown until the config loads = assume on, so a slow server never blocks.)
  // Teams personal nunca usa ACS, así que no depende de credenciales.
  const serverReady =
    platform === "zoom"
      ? platforms?.zoom !== false
      : platform === "microsoft-teams" && !detected.personal
        ? platforms?.teams !== false
        : true;

  // Un enlace que no reconocemos por nombre pero que es una URL de verdad
  // igual sirve: Unify corre AL LADO de la llamada y sus subtítulos,
  // traducción, IA y grabación no dependen de la otra plataforma. Antes esto
  // era un callejón sin salida ("no reconocimos ese enlace") aunque la persona
  // hubiera pegado una reunión perfectamente válida de otra app.
  if (platform === "unknown") {
    const host = (() => {
      try {
        return url ? new URL(url).host.replace(/^www\./, "") : null;
      } catch {
        return null;
      }
    })();
    const usable = Boolean(host) && (() => {
      try {
        return new URL(url!).pathname.replace(/\/+$/, "").length > 0;
      } catch {
        return false;
      }
    })();
    if (!usable) {
      return (
        <div className="mt-5 rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-sm text-ink-300">
          No reconocimos ese enlace como una reunión. Revisá que esté completo (por ejemplo,
          empezando con <span className="text-ink-100">https://</span>).
        </div>
      );
    }
    // Un dominio que imita a una plataforma conocida ("meet.google.com.evil.co")
    // se avisa fuerte: desde que aceptamos acompañar cualquier enlace, mostrar
    // un botón al lado no puede darle cara de confianza a un phishing.
    const impersonates = host ? impersonatedDomain(host) : null;
    if (impersonates) {
      return (
        <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <p className="text-sm font-semibold text-red-200">Cuidado con este enlace</p>
          <p className="mt-1.5 text-xs leading-relaxed text-red-100/90">
            El enlace dice <span className="font-mono text-red-50">{host}</span>, que{" "}
            <span className="font-semibold">no es</span> {impersonates} aunque se le parezca. Los
            enlaces así suelen usarse para robar contraseñas. Si esperabas una reunión de{" "}
            {impersonates}, pedile el enlace de nuevo a quien te lo mandó.
          </p>
        </div>
      );
    }
    return (
      <div className="mt-5 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
        <p className="text-sm text-ink-300">
          No conocemos <span className="font-semibold text-strong">{host}</span> por nombre, pero
          podés usar Unify al lado igual.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-ink-400">
          Abrís la llamada en {host} y acá tenés{" "}
          <span className="text-ink-200">subtítulos, traducción, transcripción, IA y grabación</span>.
          Funciona con cualquier plataforma: Unify escucha tu micrófono, no la de ellos.
        </p>
        <Button className="mt-4 w-full" onClick={onJoinEmbed} disabled={preparing}>
          {preparing ? "Preparando la grabación…" : "Unirme con Unify al lado"}
        </Button>
        <RecordingNotice />
        <a
          href={url!}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex w-full items-center justify-center rounded-xl border border-ink-600 px-4 py-2.5 text-sm font-semibold text-ink-200 hover:bg-ink-800"
        >
          Sólo abrir el enlace
        </a>
      </div>
    );
  }

  // Embeddable + we actually have what the join needs -> offer the in-app join.
  // Teams joins by its full URL; Zoom/Jitsi need the meeting id we parsed out.
  // (A Zoom personal/vanity link, or an incomplete paste, can be "embed"-capable
  // yet have no number, in which case we can't join it.)
  const canEmbed =
    // Whereby y Element Call se embeben por iframe: no necesitan credenciales
    // ni número de reunión, sólo la URL que ya trae el enlace.
    Boolean(detected.embedUrl) ||
    (info.joinMode === "embed" &&
      serverReady &&
      (platform === "microsoft-teams" ? Boolean(url) : Boolean(meetingId))) ||
    // Meet can't be embedded, but with the Unify extension the call syncs
    // live into a companion room -- so it gets the in-app join too.
    (platform === "google-meet" && Boolean(meetingId) && Boolean(url));

  // Ni embebible ni con credenciales, pero SÍ acompañable: la llamada se abre
  // en su plataforma y Unify corre al lado con subtítulos, traducción, IA y
  // grabación. Lo único que hace falta es poder identificar la sala.
  const canCompanion = !canEmbed && Boolean(url) && Boolean(roomKey);

  // Embeddable in principle (right link) but the server isn't configured for it.
  const embedNotConfigured =
    info.joinMode === "embed" &&
    !serverReady &&
    (platform === "microsoft-teams" ? Boolean(url) : Boolean(meetingId));

  return (
    <div className="mt-5 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
      <p className="text-sm text-ink-300">
        Reconocimos una reunión de{" "}
        <span className="font-semibold text-strong">{info.label}</span>
        {meetingId ? <span className="text-ink-400"> · {meetingId}</span> : null}.
      </p>

      {canEmbed ? (
        <>
          {platform === "zoom" && (
            <div className="mt-4">
              <label className={labelClass} htmlFor="zoom-passcode">
                Contraseña de la reunión (si tiene)
              </label>
              <input
                id="zoom-passcode"
                className={inputClass}
                placeholder="Ej: 123456"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={passcode}
                onChange={(e) => onPasscodeChange(e.target.value)}
                maxLength={20}
              />
              <p className="mt-1.5 text-xs text-ink-400">
                Es la contraseña que Zoom muestra junto al ID (no el código del enlace). Dejala vacía
                si la reunión no pide contraseña.
              </p>
            </div>
          )}
          <Button className="mt-4 w-full" onClick={onJoinEmbed} disabled={preparing}>
            {preparing ? "Preparando la grabación…" : "Unirme acá dentro"}
          </Button>
          <RecordingNotice />
        </>
      ) : canCompanion ? (
        // Reconocida pero no embebible: en vez de dejar a la persona sin nada,
        // entra igual a la capa de Unify (subtítulos, traducción, IA,
        // grabación) y abre la llamada en su plataforma desde adentro.
        <>
          <p className="mt-2 text-xs leading-relaxed text-ink-400">
            {embedNotConfigured
              ? `Unify no tiene configuradas las credenciales de ${info.label}, así que la llamada se abre en ${info.label}.`
              : detected.personal
                ? "Es una reunión de Teams personal y Microsoft no permite embeberlas, así que la llamada se abre en Teams."
                : `${info.label} no permite abrir la llamada dentro de otra web, así que se abre en ${info.label}.`}{" "}
            Los <span className="text-ink-200">subtítulos, la traducción, la transcripción y la IA</span>{" "}
            de Unify funcionan igual, al lado.
          </p>
          <Button className="mt-4 w-full" onClick={onJoinEmbed} disabled={preparing}>
            {preparing ? "Preparando la grabación…" : "Unirme con Unify al lado"}
          </Button>
          <RecordingNotice />
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex w-full items-center justify-center rounded-xl border border-ink-600 px-4 py-2.5 text-sm font-semibold text-ink-200 hover:bg-ink-800"
            >
              Sólo abrir en {info.label}
            </a>
          )}
        </>
      ) : (
        <>
          <p className="mt-2 text-xs text-ink-400">
            {info.joinMode === "overlay-extension"
              ? "No pudimos extraer el código de la reunión del enlace. Pegá el enlace completo de Meet (meet.google.com/xxx-xxxx-xxx)."
              : "No pudimos extraer el número de la reunión del enlace. Pegá el enlace completo (con el número) para unirte acá dentro."}
          </p>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 flex w-full items-center justify-center rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-brand-600"
            >
              Abrir en {info.label}
            </a>
          )}
        </>
      )}

      {/* El bot "Notetaker": entra a la reunión POR VOS, aunque no estés.
          Aparece cuando tenemos el enlace y la clave de sala. Si el bot no
          está encendido en el servidor, lo dice con claridad (no rompe). */}
      {url && roomKey && <BotButton url={url} roomKey={roomKey} platform={platform} lang={lang} />}
    </div>
  );
}

// La grabación automática es lo bastante importante como para decirla antes,
// no sorprender con ella. Se puede apagar acá mismo y la elección se recuerda.
function RecordingNotice() {
  const [on, setOn] = useState(() => autoRecordEnabled());
  return (
    <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-ink-400">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          setAutoRecordEnabled(e.target.checked);
        }}
        className="mt-0.5 h-4 w-4 shrink-0 accent-brand-500"
      />
      {/* En iPhone y iPad esto NO puede cumplirse: no existe grabar la
          pantalla, y grabar el micrófono apagaría los subtítulos (el sistema
          se lo da a una sola cosa a la vez). Prometerlo igual era mentir: ahí
          se cuenta lo que de verdad pasa, y cuál es la salida. */}
      {esIOS() ? (
        <span>
          <span className="font-medium text-ink-200">Grabar esta reunión automáticamente.</span> En
          iPhone y iPad el micrófono es de una sola cosa a la vez, así que adentro mandan los
          subtítulos y la grabación queda a un toque del botón Grabar. Para que quede el video
          completo sin resignar nada, mandá el bot: graba desde el servidor.
        </span>
      ) : (
        <span>
          <span className="font-medium text-ink-200">Grabar esta reunión automáticamente.</span> Al
          entrar te vamos a pedir qué pantalla grabar; si cancelás, grabamos igual el audio. Podés
          detenerla en cualquier momento desde el botón Grabar.
        </span>
      )}
    </label>
  );
}
