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
  /**
   * «El video no se escucha». Un archivo mudo pesa y se ve igual que uno
   * bueno: la única forma de que no arruine la reunión es decirlo MIENTRAS
   * se graba, y con la letra más grande de este cartel.
   */
  avisoSonido?: string | null;
  /** Pasar de sólo audio a pantalla completa: necesita un clic (gesto). */
  onAddScreen?: () => void;
  /**
   * Detener la grabación, DONDE SE VE que está grabando. Antes esto era un
   * iconito en la barra de abajo, lejos del cartel que anuncia la grabación:
   * quien quería parar tenía que adivinar cuál de seis botones era.
   */
  onStop?: () => void;
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
  avisoSonido,
  onAddScreen,
  onStop,
  onDismiss,
}: Props) {
  if (status === "idle") return null;

  if (status === "recording") {
    return (
      // EN EL FLUJO, NO ENCIMA. Esto flotaba con position absolute sobre la
      // pantalla y caía justo sobre la primera frase de los subtítulos: otra
      // vez un cartel tapando lo que la persona vino a leer (y antes,
      // comiéndose los toques del botón de abajo). Ahora ocupa su renglón.
      <div className="flex flex-col items-center gap-1.5 border-b border-ink-800 bg-ink-900/60 px-4 py-1.5">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="flex items-center gap-2 rounded-full bg-red-600/90 px-3 py-1.5 text-xs font-semibold text-on-accent shadow-soft">
            <RecordIcon className="h-3 w-3 animate-pulse" />
            {kind === "audio" ? "Grabando audio" : "Grabando"}
          </span>
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              className="min-h-[32px] rounded-full border border-ink-600 px-3 py-1 text-xs font-semibold text-ink-100 hover:border-danger hover:text-danger"
            >
              Detener grabación
            </button>
          )}
        </div>
        {avisoSonido && (
          <div className="rounded-2xl border border-red-400 bg-red-600/95 px-3 py-2 text-xs font-semibold text-on-accent shadow-soft">
            {avisoSonido}
          </div>
        )}
        {kind === "audio" ? (
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-2xl bg-black/70 px-3 py-1.5 text-[11px] text-ink-200 shadow-soft">
            <span>Estamos grabando el audio. ¿Querés que quede el video y escuchar a TODOS (no sólo tu voz)?</span>
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
          <div className="rounded-2xl bg-amber-500/90 px-3 py-1.5 text-[11px] font-medium text-ink-950 shadow-soft">
            Estás grabando la pantalla entera, así que Unify se ve dentro del video. Para evitarlo,
            detené y elegí sólo la ventana de la reunión.
          </div>
        ) : (
          <div className="rounded-full bg-black/60 px-3 py-1 text-[11px] text-ink-200 shadow-soft">
            Tu voz queda grabada siempre. Para grabar también lo que dicen los demás, compartí "esta
            pestaña" con la casilla de audio tildada.
          </div>
        )}
      </div>
    );
  }

  if (status === "processing") {
    return (
      <div className="flex justify-center border-b border-ink-800 bg-ink-900/60 px-4 py-1.5">
        <div className="rounded-full bg-ink-800/90 px-3 py-1.5 text-xs font-medium text-strong shadow-soft">
          Procesando grabación…
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex justify-center border-b border-ink-800 bg-ink-900/60 px-4 py-1.5">
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
    <div className="mx-auto w-full max-w-sm px-4 py-2">
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
