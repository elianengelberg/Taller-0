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
  subtitleStage,
}: {
  meetLink: string;
  meetCode: string;
  subtitleStage?: React.ReactNode;
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
    <div className="flex h-full min-h-0 flex-col">
      {/* Cabecera compacta: la reunión vive en Meet, así que acá alcanza con
          poder abrirla y ver el estado. El espacio es para los subtítulos. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-800 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-brand-300">Google Meet</p>
          <p className="truncate font-mono text-sm text-strong">{meetCode}</p>
        </div>
        <a
          href={meetLink}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto shrink-0 rounded-xl bg-brand-500 px-3.5 py-2 text-xs font-semibold text-on-accent hover:bg-brand-600"
        >
          Abrir en Meet
        </a>
        {fresh && meetState ? (
          <span className="flex w-full items-center gap-1.5 text-[11px] text-accent-green">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-green" />
            Extensión conectada
            {meetState.participantCount !== null && ` · ${meetState.participantCount} en Meet`}
            {meetState.presenting && " · presentando"}
          </span>
        ) : (
          <span className="w-full text-[11px] text-ink-500">
            Dejá esta pantalla al lado de Meet para leer los subtítulos mientras hablan.
          </span>
        )}
      </div>

      {/* Sin la extensión conectada (el celular, siempre), lo más importante
          de la pantalla es ENTRAR a la reunión de verdad: botón grande, no el
          enlacecito de la esquina. En el teléfono abre la app de Meet. */}
      {!fresh && (
        <div className="px-4 pt-3">
          <a
            href={meetLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-2xl bg-brand-500 px-4 py-3 text-sm font-bold text-on-accent shadow-md hover:bg-brand-600"
          >
            Abrir la reunión de Meet →
          </a>
          <p className="mt-1.5 text-center text-[11px] leading-snug text-ink-400">
            La reunión se abre en su app o pestaña. Volvé acá para leer los subtítulos con su
            traducción.
          </p>
        </div>
      )}

      {/* El resto es la pantalla de subtítulos. */}
      <div className="min-h-0 flex-1">{subtitleStage}</div>
    </div>
  );
}

// Vista larga anterior (estado detallado de la extensión), conservada para
// cuando no hay escenario de subtítulos que mostrar.
export function MeetStateDetail({ meetState, fresh }: { meetState: any; fresh: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto p-6 text-center">
      <p className="max-w-sm text-xs text-ink-500">
        Dejá esta pestaña abierta al lado de Meet: tus subtítulos y la transcripción compartida de
        Unify corren acá.
      </p>
    </div>
  );
}
