import { FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Button from "../components/Button";
import Logo from "../components/Logo";
import { useMeeting } from "../context/MeetingContext";
import { fetchPlatformConfig, PlatformConfig } from "../lib/api";
import { LANGUAGES } from "../lib/languages";
import { DetectedMeeting, detectMeetingPlatform } from "../lib/meetingPlatforms";
import { cardClass, inputClass, labelClass, nameInputProps, urlInputProps } from "../lib/ui";

// Entry point for joining a meeting hosted on ANOTHER platform (Zoom, Meet,
// Jitsi...). Paste a link -> we detect the platform and route it: Zoom and
// Jitsi run embedded (with Unify's transcript/AI layer on top), our own
// links jump to the native join flow, and everything else shows an honest
// "recognized, here's how to open it" card (with the real join integration
// filled in per-platform over the coming phases).
export default function ExternalJoin() {
  const navigate = useNavigate();
  const { startCompanionDraft, prewarm } = useMeeting();
  // Warm the backend/socket while they paste the link, so joining is instant.
  useEffect(() => prewarm(), [prewarm]);
  const [link, setLink] = useState("");
  // Remembered across sessions so the from-Meet flow (extension button) can
  // skip straight into the companion without retyping anything.
  const [name, setName] = useState(() => localStorage.getItem("unify_external_name") ?? "");
  const [language, setLanguage] = useState(LANGUAGES[0].code);
  const [passcode, setPasscode] = useState("");
  const [detected, setDetected] = useState<DetectedMeeting | null>(null);
  // Which platforms the server can actually embed (Zoom/Teams need credentials),
  // so we can be honest before the user tries instead of failing inside the embed.
  const [platforms, setPlatforms] = useState<PlatformConfig | null>(null);
  useEffect(() => {
    fetchPlatformConfig().then(setPlatforms);
  }, []);

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

  // Starts a companion session for a detected embeddable meeting: builds the
  // shared backend room key (deterministic from the meeting's own id, so
  // everyone who opens the same link lands together) and the per-platform
  // embed descriptor, then jumps into the overlay page.
  function joinDetected(target: DetectedMeeting) {
    if (name.trim()) localStorage.setItem("unify_external_name", name.trim());
    const base = { name: name.trim() || "Invitado", language };

    if (target.platform === "jitsi" && target.meetingId) {
      const room = target.meetingId;
      startCompanionDraft({
        ...base,
        // Lowercased to match how Jitsi normalizes room names, so two people
        // who paste slightly differently-cased links still share one room.
        externalKey: `jitsi:${room.toLowerCase()}`,
        roomLabel: `Jitsi · ${room}`,
        embed: { kind: "jitsi", roomName: room },
      });
      navigate("/externa/reunion");
      return;
    }

    if (target.platform === "zoom" && target.meetingId) {
      const mn = target.meetingId;
      startCompanionDraft({
        ...base,
        externalKey: `zoom:${mn}`,
        roomLabel: `Zoom · ${mn}`,
        // The plain passcode the user typed (if any). We deliberately ignore
        // the link's `pwd`: it's an encrypted token the Meeting SDK rejects.
        embed: { kind: "zoom", meetingNumber: mn, passcode: passcode.trim() || undefined },
      });
      navigate("/externa/reunion");
      return;
    }

    if (target.platform === "google-meet" && target.meetingId && target.url) {
      const code = target.meetingId;
      startCompanionDraft({
        ...base,
        externalKey: `google-meet:${code}`,
        roomLabel: `Google Meet · ${code}`,
        embed: { kind: "meet", meetCode: code, meetLink: target.url },
      });
      navigate("/externa/reunion");
      return;
    }

    if (target.platform === "microsoft-teams" && target.url) {
      startCompanionDraft({
        ...base,
        // Prefer the stable meeting thread id for the shared room key; fall
        // back to the full URL if we couldn't extract it.
        externalKey: `teams:${target.meetingId ?? target.url.toLowerCase()}`,
        roomLabel: "Microsoft Teams",
        embed: { kind: "teams", meetingLink: target.url },
      });
      navigate("/externa/reunion");
    }
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
    const prefill = searchParams.get("link");
    if (!prefill) return;
    deepLinkRan.current = true;
    setLink(prefill);
    if (searchParams.get("rec") === "1") sessionStorage.setItem("unify_autorec", "1");
    const result = detectMeetingPlatform(prefill, { selfHosts: [window.location.hostname] });
    setDetected(result);
    const savedName = (localStorage.getItem("unify_external_name") ?? "").trim();
    if (savedName && result.platform === "google-meet" && result.meetingId && result.url) {
      joinDetected(result);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <div className="flex min-h-screen flex-col items-center bg-ink-950 px-6 py-10">
      <div className="w-full max-w-md">
        <Logo className="mb-8" />
        <div className={cardClass}>
          <h1 className="text-2xl font-bold text-strong">Unirme a una reunión externa</h1>
          <p className="mt-1 text-sm text-ink-300">
            Pegá el enlace de una reunión de Zoom, Google Meet, Jitsi u otra plataforma y la
            reconocemos automáticamente.
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
                onChange={(e) => {
                  setLink(e.target.value);
                  setDetected(null);
                  setPasscode("");
                }}
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
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-ink-400">
                Se usa para tus subtítulos y traducción en vivo con la IA de Unify, encima de la
                reunión externa.
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
              onPasscodeChange={setPasscode}
              onJoinEmbed={() => joinDetected(detected)}
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
  onPasscodeChange,
  onJoinEmbed,
}: {
  detected: DetectedMeeting;
  platforms: PlatformConfig | null;
  passcode: string;
  onPasscodeChange: (value: string) => void;
  onJoinEmbed: () => void;
}) {
  const { platform, info, url, meetingId } = detected;

  // Zoom/Teams need server credentials; if the server says they're off, don't
  // offer an in-app join that would just error -- point to opening it directly.
  // (Unknown until the config loads = assume on, so a slow server never blocks.)
  const serverReady =
    platform === "zoom"
      ? platforms?.zoom !== false
      : platform === "microsoft-teams"
        ? platforms?.teams !== false
        : true;

  if (platform === "unknown") {
    return (
      <div className="mt-5 rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-sm text-ink-300">
        No reconocimos ese enlace como una reunión de una plataforma conocida. Revisá que esté
        completo (por ejemplo, empezando con <span className="text-ink-100">https://</span>).
      </div>
    );
  }

  // Embeddable + we actually have what the join needs -> offer the in-app join.
  // Teams joins by its full URL; Zoom/Jitsi need the meeting id we parsed out.
  // (A Zoom personal/vanity link, or an incomplete paste, can be "embed"-capable
  // yet have no number, in which case we can't join it.)
  const canEmbed =
    (info.joinMode === "embed" &&
      serverReady &&
      (platform === "microsoft-teams" ? Boolean(url) : Boolean(meetingId))) ||
    // Meet can't be embedded, but with the Unify extension the call syncs
    // live into a companion room -- so it gets the in-app join too.
    (platform === "google-meet" && Boolean(meetingId) && Boolean(url));

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
          <Button className="mt-4 w-full" onClick={onJoinEmbed}>
            Unirme acá dentro
          </Button>
        </>
      ) : (
        <>
          <p className="mt-2 text-xs text-ink-400">
            {embedNotConfigured
              ? `Unify todavía no tiene configuradas las credenciales de ${info.label} en el servidor, así que no podemos abrirla acá dentro. Por ahora abrila en ${info.label} (los subtítulos y la IA de Unify no aplican hasta configurarla).`
              : info.joinMode === "overlay-extension"
                ? "No pudimos extraer el código de la reunión del enlace. Pegá el enlace completo de Meet (meet.google.com/xxx-xxxx-xxx)."
                : info.joinMode === "embed"
                  ? "No pudimos extraer el número de la reunión del enlace. Pegá el enlace completo (con el número) para unirte acá dentro."
                  : "La conexión embebida a esta plataforma todavía no está disponible. Por ahora podés abrirla en su propia página."}
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
    </div>
  );
}
