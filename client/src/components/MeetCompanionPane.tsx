import { useEffect, useState } from "react";
import { useMeeting } from "../context/MeetingContext";
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon, PeopleIcon, ScreenShareIcon } from "./icons";

// Companion pane for a Google Meet call. Meet can't be embedded (no SDK,
// frame-blocked) and offers no API -- so the real call opens in its own tab
// and the Unify browser extension (see /extension) feeds live state back
// through the meet-bridge. This pane shows that state and holds the
// "open Meet" call to action; Unify's captions/transcript/AI run alongside
// off the user's own mic, exactly like the other companion modes.
export default function MeetCompanionPane({
  meetLink,
  meetCode,
}: {
  meetLink: string;
  meetCode: string;
}) {
  const { meetState } = useMeeting();
  // Freshness ticker so "extensión conectada" turns stale if reports stop.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);

  const fresh = meetState !== null && now - meetState.at < 30_000;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto p-6 text-center">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-300">Google Meet</p>
        <p className="mt-1 font-mono text-lg text-strong">{meetCode}</p>
      </div>

      <a
        href={meetLink}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-xl bg-gradient-to-b from-brand-500 to-brand-600 px-6 py-3 text-sm font-semibold text-on-accent shadow-md shadow-brand-600/25 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
      >
        Abrir la reunión en Meet
      </a>

      {fresh && meetState ? (
        <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-800/60 p-4 text-left">
          <p className="mb-3 flex items-center gap-2 text-xs font-semibold text-accent-green">
            <span className="h-2 w-2 rounded-full bg-accent-green" />
            Extensión conectada — estado en vivo de Meet
          </p>
          <ul className="space-y-2 text-sm text-ink-200">
            <li className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${meetState.inCall ? "bg-accent-green" : "bg-ink-500"}`} />
              {meetState.inCall ? "En la llamada" : "Fuera de la llamada"}
            </li>
            {meetState.participantCount !== null && (
              <li className="flex items-center gap-2">
                <PeopleIcon className="h-4 w-4 text-brand-300" />
                {meetState.participantCount} en Meet
              </li>
            )}
            {meetState.micMuted !== null && (
              <li className="flex items-center gap-2">
                {meetState.micMuted ? (
                  <MicOffIcon className="h-4 w-4 text-red-400" />
                ) : (
                  <MicIcon className="h-4 w-4 text-brand-300" />
                )}
                Micrófono {meetState.micMuted ? "silenciado" : "activo"} en Meet
              </li>
            )}
            {meetState.cameraOff !== null && (
              <li className="flex items-center gap-2">
                {meetState.cameraOff ? (
                  <CameraOffIcon className="h-4 w-4 text-red-400" />
                ) : (
                  <CameraIcon className="h-4 w-4 text-brand-300" />
                )}
                Cámara {meetState.cameraOff ? "apagada" : "prendida"} en Meet
              </li>
            )}
            {meetState.presenting && (
              <li className="flex items-center gap-2">
                <ScreenShareIcon className="h-4 w-4 text-brand-300" />
                Hay una presentación activa
              </li>
            )}
            {meetState.activeSpeakers.length > 0 && (
              <li className="text-xs text-ink-400">
                Hablando: {meetState.activeSpeakers.join(", ")}
              </li>
            )}
            {meetState.participants && (
              <li className="text-xs text-ink-400">
                En Meet: {meetState.participants.join(", ")}
              </li>
            )}
          </ul>
        </div>
      ) : (
        <div className="w-full max-w-sm rounded-2xl border border-dashed border-ink-600 p-4 text-left">
          <p className="text-sm font-medium text-strong">Sincronizá Meet con Unify</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            Instalá la extensión <span className="text-ink-200">Unify para Google Meet</span> (carpeta{" "}
            <code className="rounded bg-ink-700 px-1">extension/</code> del proyecto →{" "}
            <code className="rounded bg-ink-700 px-1">chrome://extensions</code> → &quot;Cargar
            descomprimida&quot;). Con la extensión activa, acá vas a ver en vivo el estado de la
            llamada de Meet. Sin ella, los subtítulos, la traducción y la IA de Unify siguen
            funcionando igual con tu micrófono.
          </p>
        </div>
      )}

      <p className="max-w-sm text-xs text-ink-500">
        Dejá esta pestaña abierta al lado de Meet: tus subtítulos y la transcripción compartida de
        Unify corren acá.
      </p>
    </div>
  );
}
