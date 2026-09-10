import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPlatformConfig, markRecordingStarted } from "../lib/api";
import {
  displayMediaErrorMessage,
  screenCaptureSupported,
  RECORDING_UNSUPPORTED_MESSAGE,
} from "../lib/screenCapture";
import { capturesOwnScreen } from "../lib/autoRecord";
import {
  dropRecording,
  listPendingRecordings,
  markAttempt,
  stashRecording,
  subirGrabacion,
} from "../lib/recordingVault";

export type RecordingStatus = "idle" | "recording" | "processing" | "done" | "error";
export type UploadStatus = "idle" | "uploading" | "uploaded" | "unavailable" | "failed";
/** Qué se está grabando: la pantalla con su audio, o sólo el micrófono. */
export type RecordingKind = "screen" | "audio";

interface UseRecorderOptions {
  micStream: MediaStream | null;
  meetingDbId: string | null;
}

export interface StartOptions {
  /**
   * Captura ya obtenida durante un gesto del usuario (ver lib/autoRecord).
   * Se usa tal cual en vez de volver a pedir permiso -- que es justamente lo
   * que el navegador no permitiría fuera del gesto.
   */
  stream?: MediaStream | null;
  /**
   * Grabar sólo el micrófono, sin pedir la pantalla. Es el modo con el que
   * arranca la grabación automática cuando no hay gesto disponible.
   */
  audioOnly?: boolean;
  /**
   * LA PERSONA APRETÓ GRABAR. Cambia dos cosas, y las dos importan:
   *
   *  - Si la captura vino sin sonido, se le pide el MICRÓFONO para que la
   *    grabación no salga muda. Eso puede abrir el cartel de permisos del
   *    navegador, y por eso NO se hace en la grabación automática: pedir
   *    permiso por el solo hecho de abrir la pantalla es exactamente lo que
   *    se sacó («cada vez que abro la pantalla me tira si autorizo el
   *    micrófono»). Con el permiso YA dado no hay cartel, así que ahí se pide
   *    igual, gesto o no.
   *  - El aviso «esta grabación está saliendo sin sonido» se muestra sólo
   *    cuando la persona pidió grabar: es cuando puede hacer algo al
   *    respecto. En la automática, ese cartel se comía un renglón de
   *    subtítulos para avisar de algo que nadie pidió.
   */
  porGesto?: boolean;
}

// Sólo audio: el mismo criterio que arriba (MP4 primero por iPhone/iPad).
function pickAudioMimeType(): string | undefined {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return undefined;
}

// MP4 (H.264 + AAC) first: it's the only format that also plays on
// iPhone/iPad Safari, which can't decode WebM files -- recordings used to
// "look empty" there while playing fine on desktop. WebM stays as the
// fallback for browsers whose MediaRecorder can't mux MP4 yet.
function pickSupportedMimeType(): string | undefined {
  const candidates = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(type)) {
      return type;
    }
  }
  return undefined;
}

// MediaRecorder's default video bitrate (~2.5 Mbps) makes 1080p+ screen
// content look smeared. Scale the target with the actually-captured size --
// asking for 12 Mbps at 720p just wastes upload, and 2.5 Mbps at 4K is mush.
function videoBitrateFor(track: MediaStreamTrack): number {
  const { width = 1920, height = 1080 } = track.getSettings();
  const pixels = width * height;
  if (pixels >= 3200 * 1700) return 12_000_000; // 4K / retina fullscreen
  if (pixels >= 1900 * 1000) return 8_000_000; // 1080p-1440p
  if (pixels >= 1200 * 650) return 5_000_000; // 720p-900p
  return 3_500_000;
}

// Records the shared screen/tab + its audio, mixed with the local
// microphone (via Web Audio), so the file captures the whole conversation --
// not just what the recording user hears.
export function useRecorder({ micStream, meetingDbId }: UseRecorderOptions) {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  // Actual container of the finished file ("video/mp4" or "video/webm"), so
  // the download button can name the file with the right extension.
  const [resultType, setResultType] = useState<string>("video/webm");
  // Mirror for the unmount cleanup below -- leaving the page without
  // dismissing the "Grabación lista" card would otherwise leak the blob URL
  // (and the recording's memory) for the rest of the session.
  const resultUrlRef = useRef<string | null>(null);
  resultUrlRef.current = resultUrl;

  // Qué se está grabando ahora mismo, y si la captura incluye a esta misma
  // pantalla (efecto túnel) -- la UI lo avisa en vez de dejar que sorprenda.
  const [kind, setKind] = useState<RecordingKind>("screen");
  const [selfCapture, setSelfCapture] = useState(false);
  // La pista de audio que vino CON la captura (el sonido de la reunión: las
  // voces de los demás). Expuesta para que el companion la transcriba -- ver
  // useReconocimientoDePista. Null cuando se graba sólo audio del micrófono o
  // cuando la persona compartió sin tildar "compartir audio".
  const [remoteAudioTrack, setRemoteAudioTrack] = useState<MediaStreamTrack | null>(null);
  /**
   * EL VIDEO QUE NO SE ESCUCHA. Pasó en una reunión de verdad: se graba la
   * pantalla, el archivo pesa, se ve perfecto... y no tiene una sola voz.
   *
   * Por qué: el audio de la grabación sale de un `MediaStreamDestination`, y
   * ese nodo SIEMPRE entrega una pista de audio -- aunque no haya nada
   * conectado. Si la persona compartió la pantalla sin tildar «Compartir
   * audio» y no había micrófono, la mezcla queda en silencio absoluto, el
   * archivo tiene su pista muda, pesa lo que tiene que pesar, y nada falla:
   * el problema aparece recién al reproducirlo, cuando ya no se puede
   * volver a grabar esa reunión.
   *
   * Este aviso existe para que se sepa MIENTRAS se graba, que es el único
   * momento en que se puede arreglar.
   */
  const [avisoSonido, setAvisoSonido] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const ownAudioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  // Vigía de silencio: mira el nivel de la mezcla mientras se graba.
  const vigiaSonidoRef = useRef<number | null>(null);
  /**
   * QUÉ GRABACIÓN ES LA QUE ESTÁ CORRIENDO.
   *
   * «Agregar pantalla» hace `stop()` y enseguida `start()`. Pero `stop()` no
   * termina en el acto: el `onstop` del grabador viejo llega DESPUÉS, cuando
   * la grabación nueva ya abrió su micrófono y su AudioContext... y ese
   * `onstop` llamaba a `cleanupStreams()`, que cerraba las pistas y el
   * contexto DE LA NUEVA. Resultado: la grabación de pantalla quedaba con su
   * mezcla muerta -- un video que pesa, se ve bien y no se escucha.
   *
   * Con un número de generación, la limpieza de una grabación sólo puede
   * tocar sus propias cosas: si ya arrancó otra, no toca nada.
   */
  const generacionRef = useRef(0);
  // Reloj real de la grabación: la duración que mandamos al servidor ancla el
  // t=0 del video contra la transcripción en el historial.
  const startedAtRef = useRef(0);

  const cleanupStreams = useCallback((generacion?: number) => {
    if (generacion !== undefined && generacion !== generacionRef.current) return;
    displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    displayStreamRef.current = null;
    setRemoteAudioTrack(null);
    // Sólo cerramos el micrófono que abrimos nosotros; el que llega por
    // `micStream` es de quien nos lo pasó y sigue en uso en la reunión.
    ownAudioStreamRef.current?.getTracks().forEach((track) => track.stop());
    ownAudioStreamRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    if (vigiaSonidoRef.current !== null) {
      clearInterval(vigiaSonidoRef.current);
      vigiaSonidoRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setStatus("processing");
      recorder.stop();
    }
  }, []);

  // Sube una grabación y devuelve si llegó. Sin estado de React adentro, así
  // sirve tanto para la grabación recién hecha como para reintentar las que
  // quedaron guardadas en la bóveda de una sesión anterior.
  const pushRecording = useCallback(
    async (dbId: string, blob: Blob, contentType: string, durationMs: number): Promise<boolean> => {
      // La subida real vive en recordingVault (subirGrabacion): la comparte
      // el rescate a mano del historial, así los dos caminos suben IGUAL.
      return subirGrabacion(dbId, blob, contentType, durationMs);
    },
    []
  );

  const uploadRecording = useCallback(
    async (blob: Blob, contentType: string, durationMs: number) => {
      if (!meetingDbId) {
        setUploadStatus("unavailable");
        return;
      }
      setUploadStatus("uploading");
      // Si el servidor no tiene almacenamiento configurado, la subida no puede
      // funcionar por más que se reintente: no se guarda nada en el navegador
      // (sería llenarle el disco al usuario para nada) y se lo decimos.
      if ((await fetchPlatformConfig()).recording === false) {
        setUploadStatus("unavailable");
        return;
      }
      // Al disco ANTES de intentar subir: si se cierra la pestaña, se corta la
      // red o el servidor está dormido, la grabación sigue existiendo y se
      // reintenta sola la próxima vez que se abra Unify.
      const vaultId = await stashRecording({
        meetingDbId,
        blob,
        contentType,
        durationMs,
      });
      const ok = await pushRecording(meetingDbId, blob, contentType, durationMs);
      if (ok && vaultId) await dropRecording(vaultId);
      setUploadStatus(ok ? "uploaded" : vaultId ? "failed" : "unavailable");
    },
    [meetingDbId, pushRecording]
  );

  // Reintento de rescate: al montar, se sube lo que haya quedado colgado de
  // una sesión anterior (pestaña cerrada a mitad de subida, red caída,
  // servidor dormido). En segundo plano y en silencio -- no es lo que la
  // persona vino a hacer ahora.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pending = await listPendingRecordings();
      if (pending.length === 0) return;
      // Mismo criterio que arriba: sin almacenamiento no hay a dónde subirlas.
      if ((await fetchPlatformConfig()).recording === false) return;
      for (const rec of pending) {
        if (cancelled) return;
        // Tres intentos y se deja quieta hasta que venza: reintentar sin
        // límite una grabación de una reunión borrada sería gastar datos del
        // usuario para siempre.
        if (rec.attempts >= 3) continue;
        await markAttempt(rec.id);
        const ok = await pushRecording(rec.meetingDbId, rec.blob, rec.contentType, rec.durationMs);
        if (ok) await dropRecording(rec.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushRecording]);

  // Grabación sólo de micrófono. Es la que puede arrancar SOLA: getUserMedia no
  // exige un gesto del usuario (getDisplayMedia sí), así que con el permiso de
  // micrófono ya dado -- que en una reunión externa siempre está, porque los
  // subtítulos lo usan -- la reunión queda grabada sin que nadie apriete nada.
  const startAudioOnly = useCallback(async () => {
    // Lo de la grabación anterior se suelta ACÁ, antes de abrir nada nuevo.
    // (Su propio `onstop` ya no puede hacerlo: con el número de generación
    // sólo toca lo suyo, y para cuando llega esto ya es «lo de otra».)
    cleanupStreams();
    const generacion = ++generacionRef.current;
    try {
      const source =
        micStream && micStream.getAudioTracks().some((t) => t.readyState === "live")
          ? micStream
          : await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
            });
      // Sólo cerramos al final el micrófono que abrimos nosotros.
      if (source !== micStream) ownAudioStreamRef.current = source;

      const mimeType = pickAudioMimeType();
      const recorder = new MediaRecorder(source, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 128_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const contentType = (mimeType || "audio/webm").split(";")[0];
        const blob = new Blob(chunksRef.current, { type: contentType });
        const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
        // Sólo lo mío: si «Agregar pantalla» ya arrancó la grabación
        // siguiente, cerrarle el micrófono la dejaría muda.
        cleanupStreams(generacion);
        // Umbral mucho más bajo que el de video: un minuto de audio pesa
        // ~1 MB, y un audio corto igual es una grabación válida.
        if (blob.size < 2_000) {
          setError("La grabación de audio quedó vacía: no llegó sonido del micrófono.");
          setStatus("error");
          return;
        }
        setResultType(contentType);
        setResultUrl(URL.createObjectURL(blob));
        setStatus("done");
        void uploadRecording(blob, contentType, durationMs);
      };
      recorder.onerror = () => {
        setError("Hubo un error grabando el audio de la reunión.");
        setStatus("error");
        cleanupStreams(generacion);
      };
      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      startedAtRef.current = Date.now();
      setStatus("recording");
      if (meetingDbId) void markRecordingStarted(meetingDbId);
    } catch (err) {
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      setError(
        denied
          ? "No pudimos grabar: el navegador tiene bloqueado el micrófono para este sitio. Habilitalo y volvé a intentar."
          : "No pudimos acceder al micrófono para grabar la reunión."
      );
      setStatus("error");
      cleanupStreams(generacion);
    }
  }, [micStream, cleanupStreams, uploadRecording, meetingDbId]);

  const start = useCallback(
    async (options: StartOptions = {}) => {
    setError(null);
    setResultUrl(null);
    setUploadStatus("idle");
    setSelfCapture(false);
    setRemoteAudioTrack(null);
    setAvisoSonido(null);
    const audioOnly = Boolean(options.audioOnly);
    setKind(audioOnly ? "audio" : "screen");
    if (!audioOnly && !options.stream && !screenCaptureSupported) {
      setError(RECORDING_UNSUPPORTED_MESSAGE);
      setStatus("error");
      return;
    }
    if (audioOnly) {
      await startAudioOnly();
      return;
    }
    // Idem: el micrófono y la captura de la grabación anterior se cierran
    // antes de pedir los nuevos, para no dejar viva la lucecita del navegador.
    cleanupStreams();
    const generacion = ++generacionRef.current;
    try {
      const displayStream =
        options.stream ??
        (await navigator.mediaDevices.getDisplayMedia({
          // Without explicit ideals Chrome sometimes hands back a downscaled
          // capture; asking high keeps the surface at its native resolution.
          // `displaySurface: "monitor"` abre el selector ya parado en "Pantalla
          // completa": la ventana de Zoom minimizada NI APARECE en la lista de
          // ventanas, pero la pantalla entera está siempre -- y ahí se ve la
          // reunión tal cual la persona la mira.
          video: {
            width: { ideal: 3840 },
            height: { ideal: 2160 },
            frameRate: { ideal: 30 },
            displaySurface: "monitor",
          },
          audio: true,
          // Saca esta misma pestaña del selector: es lo que evita el "túnel
          // infinito" de grabar la pantalla donde se ve la grabación.
          selfBrowserSurface: "exclude",
          // Y que la pestaña "Pantalla completa" exista aunque el navegador
          // dude (extensión de Chromium; el resto la ignora).
          monitorTypeSurfaces: "include",
          // Que el selector ofrezca el audio del SISTEMA al compartir la
          // pantalla entera: ahí viven las voces de la reunión cuando está en
          // otra app (Zoom de escritorio). Extensión de Chromium; los
          // navegadores que no la conocen la ignoran.
          systemAudio: "include",
        } as DisplayMediaStreamOptions));
      displayStreamRef.current = displayStream;
      setRemoteAudioTrack(displayStream.getAudioTracks()[0] ?? null);
      // Compartir el monitor entero con Unify a la vista sí produce el túnel,
      // y eso no se puede impedir -- pero sí avisarlo.
      setSelfCapture(capturesOwnScreen(displayStream));
      // Screen content is mostly text/UI: "detail" tells the encoder to spend
      // its bits on sharpness instead of smooth motion.
      const captureTrack = displayStream.getVideoTracks()[0];
      if (captureTrack) captureTrack.contentHint = "detail";

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      // Chrome can create this suspended when there's an async gap (like the
      // getDisplayMedia permission prompt) between the click that started
      // recording and this point -- if we don't resume it explicitly, the
      // mixed audio track silently produces no sound at all, even though the
      // video track (which doesn't go through the AudioContext) works fine.
      if (audioContext.state === "suspended") {
        await audioContext.resume().catch(() => {});
      }
      const destination = audioContext.createMediaStreamDestination();

      const hayAudioDeLaCaptura = displayStream.getAudioTracks().length > 0;
      if (hayAudioDeLaCaptura) {
        audioContext
          .createMediaStreamSource(new MediaStream(displayStream.getAudioTracks()))
          .connect(destination);
      }

      // EL MICRÓFONO, SIEMPRE QUE SE PUEDA. La pantalla de reunión externa
      // llama a este hook con `micStream: null`, así que la única fuente de
      // sonido era la casilla «Compartir audio» del selector de Chrome. Sin
      // tildarla -- que es lo que pasa la mayoría de las veces -- el video
      // salía MUDO y sin un aviso, y eso no se descubre hasta reproducirlo,
      // cuando ya no hay reunión que volver a grabar. Ahora, si la captura
      // vino sin sonido, el grabador abre el micrófono por su cuenta:
      // getUserMedia no exige un gesto del usuario, así que se puede pedir
      // acá aunque el clic ya se lo haya llevado getDisplayMedia.
      let micUsado =
        micStream && micStream.getAudioTracks().some((t) => t.readyState === "live") ? micStream : null;
      // Con el permiso ya concedido, pedir el micrófono no abre ningún
      // cartel: se puede hacer siempre. Si no está concedido, sólo cuando la
      // persona apretó grabar. (`permissions.query` no existe o no contesta
      // en algunos navegadores -- iPad entre ellos --: ahí manda el gesto.)
      let puedePedirMic = Boolean(options.porGesto);
      if (!puedePedirMic) {
        try {
          const estado = await navigator.permissions?.query?.({
            name: "microphone" as PermissionName,
          });
          puedePedirMic = estado?.state === "granted";
        } catch {
          puedePedirMic = false;
        }
      }
      if (!micUsado && puedePedirMic) {
        // CON RELOJ. Si el permiso del micrófono está en "preguntar", esto
        // abre el cartel del navegador -- y mientras nadie conteste, la
        // grabación NO EMPIEZA, con la pantalla ya compartida y la barra de
        // "estás compartiendo" puesta. Una grabación que no arranca es peor
        // que una sin micrófono: a los seis segundos se sigue sin él (y el
        // vigía de silencio avisa si además la captura vino muda). Si la
        // respuesta llega tarde, esa pista se cierra en vez de quedar viva.
        const pedido = navigator.mediaDevices
          .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
          .catch(() => null);
        const propio = await Promise.race([
          pedido,
          new Promise<null>((r) => setTimeout(() => r(null), 6000)),
        ]);
        if (propio) {
          ownAudioStreamRef.current = propio;
          micUsado = propio;
        } else {
          void pedido.then((tardio) => {
            if (tardio && tardio !== ownAudioStreamRef.current) tardio.getTracks().forEach((t) => t.stop());
          });
        }
      }
      const hayMicrofono = Boolean(micUsado && micUsado.getAudioTracks().length > 0);
      if (micUsado && hayMicrofono) {
        audioContext
          .createMediaStreamSource(new MediaStream(micUsado.getAudioTracks()))
          .connect(destination);
      }

      // Ni la captura ni el micrófono: el archivo va a salir mudo, y hay que
      // decirlo ahora... si la persona pidió grabar. En la automática el aviso
      // sobra: nadie lo pidió, y el renglón que ocupa es un renglón menos de
      // subtítulos (en una ventana chica, el último).
      setAvisoSonido(
        hayAudioDeLaCaptura || hayMicrofono || !options.porGesto
          ? null
          : "Esta grabación está saliendo SIN SONIDO: se compartió la pantalla sin tildar «Compartir audio» y tampoco hay micrófono. Detené, volvé a grabar y tildá la casilla de audio."
      );

      const combined = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);

      const mimeType = pickSupportedMimeType();
      const recorder = new MediaRecorder(combined, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: captureTrack ? videoBitrateFor(captureTrack) : 8_000_000,
        audioBitsPerSecond: 192_000,
      });
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const contentType = (mimeType || "video/webm").split(";")[0];
        const blob = new Blob(chunksRef.current, { type: contentType });
        const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
        cleanupStreams(generacion);
        // A "successful" recording with (almost) no data means the capture
        // never produced frames -- typically a minimized window, a closed
        // source, or stopping immediately. Saying so beats handing the user
        // an empty file that "doesn't play".
        if (blob.size < 20_000) {
          setError(
            "La grabación quedó vacía. Suele pasar si la ventana elegida estaba minimizada, si la fuente se cerró o si se detuvo al instante. Elegí una pestaña o pantalla visible y probá de nuevo."
          );
          setStatus("error");
          return;
        }
        setResultType(contentType);
        setResultUrl(URL.createObjectURL(blob));
        setStatus("done");
        void uploadRecording(blob, contentType, durationMs);
      };

      recorder.onerror = () => {
        setError("Hubo un error grabando la reunión.");
        setStatus("error");
        cleanupStreams(generacion);
      };

      // If the user stops sharing from the browser's own "Stop sharing" UI,
      // treat it the same as pressing our stop button.
      displayStream.getVideoTracks()[0]?.addEventListener("ended", stop);

      // EL VIGÍA DE SILENCIO. Tener una fuente conectada no garantiza que
      // suene: la pestaña compartida puede estar muda, el micrófono puede ser
      // de un aparato apagado, y Chrome puede entregar la pista del audio del
      // sistema sin nada adentro. Se mira el nivel REAL de la mezcla y, si a
      // los doce segundos no entró absolutamente nada, se avisa igual --
      // mientras todavía hay reunión para volver a grabar.
      if (options.porGesto) {
        const analizador = audioContext.createAnalyser();
        analizador.fftSize = 512;
        if (destination.stream.getAudioTracks().length > 0) {
          audioContext.createMediaStreamSource(destination.stream).connect(analizador);
        }
        const muestras = new Uint8Array(analizador.fftSize);
        const desde = Date.now();
        const cortar = () => {
          if (vigiaSonidoRef.current !== null) {
            clearInterval(vigiaSonidoRef.current);
            vigiaSonidoRef.current = null;
          }
        };
        vigiaSonidoRef.current = window.setInterval(() => {
          analizador.getByteTimeDomainData(muestras);
          let pico = 0;
          for (const v of muestras) pico = Math.max(pico, Math.abs(v - 128));
          if (pico > 2) {
            setAvisoSonido(null);
            cortar();
            return;
          }
          if (Date.now() - desde > 12_000) {
            setAvisoSonido(
              "Llevamos 12 segundos grabando y no está entrando NADA de sonido. Detené, volvé a grabar y tildá «Compartir audio» en el selector de Chrome (o dale permiso al micrófono)."
            );
            cortar();
          }
        }, 1000);
      }

      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      startedAtRef.current = Date.now();
      setStatus("recording");
      // Anchor the video's t=0 on the server so the saved transcript lines up.
      if (meetingDbId) void markRecordingStarted(meetingDbId);
    } catch (err) {
      // El stream cedido puede haber muerto entre el gesto y acá; no dejamos
      // sus pistas abiertas por el error.
      options.stream?.getTracks().forEach((t) => t.stop());
      setError(displayMediaErrorMessage(err, "iniciar la grabación"));
      setStatus("error");
      cleanupStreams(generacion);
    }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [micStream, cleanupStreams, stop, uploadRecording, meetingDbId, startAudioOnly]
  );

  // Cerrar la pestaña mientras se graba o mientras el video está subiendo
  // abandonaba el archivo a mitad de camino. Ahora el navegador pregunta antes
  // ("¿seguro que querés salir?") y, si igual se va, la grabación ya quedó en
  // la bóveda (IndexedDB) y se reintenta sola al volver a abrir Unify.
  useEffect(() => {
    const busy = status === "recording" || status === "processing" || uploadStatus === "uploading";
    if (!busy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Los navegadores modernos muestran su propio texto; devolver algo es lo
      // que dispara el diálogo.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [status, uploadStatus]);

  const reset = useCallback(() => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    setStatus("idle");
    setUploadStatus("idle");
    setError(null);
  }, [resultUrl]);

  // Without this, leaving the meeting mid-recording (navigating away,
  // closing the tab) left the getDisplayMedia stream and AudioContext
  // running forever -- the browser's "you are sharing your screen" bar
  // would stay up with nothing left to stop it. `stop()` still lets
  // onstop's upload-to-history logic run normally; it just also makes sure
  // we're not leaking a live screen-capture stream in the background.
  useEffect(() => {
    return () => {
      stop();
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    };
  }, [stop]);

  return {
    status, uploadStatus, error, resultUrl, resultType, kind, selfCapture, remoteAudioTrack,
    avisoSonido, start, stop, reset,
  };
}
