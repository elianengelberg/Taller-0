import { RecordingKind, RecordingStatus, UploadStatus } from "../hooks/useRecorder";
import { CloseIcon, DownloadIcon, RecordIcon } from "./icons";

interface Props {
  status: RecordingStatus;
  uploadStatus: UploadStatus;
  error: string | null;
  resultUrl: string | null;
  // Container of the finished file, e.g. "video/mp4" -- names the download.
  resultType?: string;
  /** "audio" cuando la grabación arrancó sola sin captura de pantalla. */
  kind?: RecordingKind;
  /** La captura incluye esta misma pantalla (efecto túnel). */
  selfCapture?: boolean;
  /** Pasar de sólo audio a pantalla completa: necesita un clic (gesto). */
  onAddScreen?: () => void;
  onDismiss: () => void;
}

export default function RecordingBanner({
  status,
  uploadStatus,
  error,
  resultUrl,
  resultType,
  kind = "screen",
  selfCapture,
  onAddScreen,
  onDismiss,
}: Props) {
  if (status === "idle") return null;

  if (status === "recording") {
    // En el teléfono, top-4 chocaba con la barra de Unify: baja un escalón
    // (los dos estados con tarjeta usan el mismo corrimiento).
    return (
      <div className="absolute left-1/2 top-16 flex max-w-[92vw] -translate-x-1/2 flex-col items-center gap-1.5">
        <div className="pointer-events-none flex items-center gap-2 rounded-full bg-red-600/90 px-3 py-1.5 text-xs font-semibold text-on-accent shadow-soft">
          <RecordIcon className="h-3 w-3 animate-pulse" />
          {kind === "audio" ? "Grabando audio" : "Grabando"}
        </div>
        {kind === "audio" ? (
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-2xl bg-black/70 px-3 py-1.5 text-[11px] text-ink-200 shadow-soft">
            <span>Estamos grabando el audio. ¿Querés que también quede el video?</span>
            {onAddScreen && (
              <button
                type="button"
                onClick={onAddScreen}
                className="rounded-lg bg-brand-500 px-2.5 py-1 font-semibold text-on-accent hover:bg-brand-600"
              >
                Agregar pantalla
              </button>
            )}
          </div>
        ) : selfCapture ? (
          <div className="pointer-events-none rounded-2xl bg-amber-500/90 px-3 py-1.5 text-[11px] font-medium text-ink-950 shadow-soft">
            Estás grabando la pantalla entera, así que Unify se ve dentro del video. Para evitarlo,
            detené y elegí sólo la ventana de la reunión.
          </div>
        ) : (
          <div className="pointer-events-none rounded-full bg-black/60 px-3 py-1 text-[11px] text-ink-200 shadow-soft">
            Tu voz queda grabada siempre. Para grabar también lo que dicen los demás, compartí "esta
            pestaña" con la casilla de audio tildada.
          </div>
        )}
      </div>
    );
  }

  if (status === "processing") {
    return (
      <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2">
        <div className="rounded-full bg-ink-800/90 px-3 py-1.5 text-xs font-medium text-strong shadow-soft">
          Procesando grabación…
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="absolute left-1/2 top-4 -translate-x-1/2 px-4">
        <div className="flex items-center gap-2 rounded-xl bg-red-600/90 px-3 py-2 text-xs font-medium text-on-accent shadow-soft">
          {error ?? "No se pudo grabar."}
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-full p-0.5 hover:bg-white/20"
            aria-label="Cerrar"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute left-1/2 top-16 w-full max-w-sm -translate-x-1/2 px-4">
      <div className="rounded-xl border border-ink-700 bg-ink-800 p-3 shadow-soft">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-strong">Grabación lista</p>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-full p-1 text-ink-400 hover:bg-ink-700"
            aria-label="Cerrar"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-400">{uploadStatusLabel(uploadStatus)}</p>
        {resultUrl && (
          <a
            href={resultUrl}
            download={`reunion-${Date.now()}.${downloadExtension(resultType)}`}
            className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-on-accent hover:bg-brand-600"
          >
            <DownloadIcon className="h-4 w-4" />
            {resultType?.startsWith("audio/") ? "Descargar audio" : "Descargar video"}
          </a>
        )}
      </div>
    </div>
  );
}

function downloadExtension(resultType?: string): string {
  if (resultType === "audio/mp4") return "m4a";
  if (resultType === "audio/webm") return "webm";
  return resultType?.includes("mp4") ? "mp4" : "webm";
}

function uploadStatusLabel(status: UploadStatus): string {
  switch (status) {
    case "uploading":
      return "Guardando en el historial de la reunión…";
    case "uploaded":
      return "Guardada en el historial — la podés ver ahí cuando quieras.";
    case "unavailable":
      return "El guardado permanente no está configurado en este servidor; descargala para conservarla.";
    case "failed":
      return "No se pudo subir al historial ahora, pero quedó guardada en este navegador y lo reintentamos solos la próxima vez que abras Unify. También podés descargarla.";
    default:
      return "";
  }
}
