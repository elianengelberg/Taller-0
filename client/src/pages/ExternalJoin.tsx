import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/Button";
import JitsiEmbed from "../components/JitsiEmbed";
import Logo from "../components/Logo";
import { DetectedMeeting, detectMeetingPlatform } from "../lib/meetingPlatforms";
import { cardClass, inputClass, labelClass } from "../lib/ui";

// Entry point for joining a meeting hosted on ANOTHER platform (Zoom, Meet,
// Jitsi...). Paste a link -> we detect the platform and route it: Jitsi runs
// embedded here, our own links jump to the native join flow, and everything
// else shows an honest "recognized, here's how to open it" card (with the
// real join integration filled in per-platform over the coming phases).
export default function ExternalJoin() {
  const navigate = useNavigate();
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [detected, setDetected] = useState<DetectedMeeting | null>(null);
  const [joining, setJoining] = useState(false);

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

  // Once we have a name + a Jitsi room, show the embedded meeting full-bleed
  // with our header on top -- our interface around a real external call.
  if (joining && detected?.platform === "jitsi" && detected.meetingId) {
    return (
      <div className="flex h-dvh flex-col bg-ink-950">
        <header className="flex items-center justify-between border-b border-ink-700 bg-ink-900 px-4 py-3 sm:px-6">
          <Logo />
          <button
            type="button"
            onClick={() => navigate("/", { replace: true })}
            className="text-sm font-medium text-ink-300 hover:text-white"
          >
            Salir
          </button>
        </header>
        <div className="flex-1 overflow-hidden">
          <JitsiEmbed
            roomName={detected.meetingId}
            displayName={name.trim() || "Invitado"}
            onLeave={() => navigate("/", { replace: true })}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-ink-950 px-6 py-10">
      <div className="w-full max-w-md">
        <Logo className="mb-8" />
        <div className={cardClass}>
          <h1 className="text-2xl font-bold text-white">Unirme a una reunión externa</h1>
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
                value={link}
                onChange={(e) => {
                  setLink(e.target.value);
                  setDetected(null);
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
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
              />
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
              onJoinJitsi={() => setJoining(true)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DetectionResult({
  detected,
  onJoinJitsi,
}: {
  detected: DetectedMeeting;
  onJoinJitsi: () => void;
}) {
  const { platform, info, url, meetingId } = detected;

  if (platform === "unknown") {
    return (
      <div className="mt-5 rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-sm text-ink-300">
        No reconocimos ese enlace como una reunión de una plataforma conocida. Revisá que esté
        completo (por ejemplo, empezando con <span className="text-ink-100">https://</span>).
      </div>
    );
  }

  return (
    <div className="mt-5 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
      <p className="text-sm text-ink-300">
        Reconocimos una reunión de{" "}
        <span className="font-semibold text-white">{info.label}</span>
        {meetingId ? <span className="text-ink-400"> · {meetingId}</span> : null}.
      </p>

      {platform === "jitsi" ? (
        <Button className="mt-4 w-full" onClick={onJoinJitsi}>
          Unirme acá dentro
        </Button>
      ) : (
        <>
          <p className="mt-2 text-xs text-ink-400">
            {info.joinMode === "overlay-extension"
              ? "Esta plataforma no permite embeberse; se integra con una extensión del navegador (próximamente)."
              : "La conexión embebida a esta plataforma todavía no está disponible. Por ahora podés abrirla en su propia página."}
          </p>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 flex w-full items-center justify-center rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
            >
              Abrir en {info.label}
            </a>
          )}
        </>
      )}
    </div>
  );
}
