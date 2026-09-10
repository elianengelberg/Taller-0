import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { dispatchBot } from "../lib/api";
import { SERVER_URL } from "../lib/socket";

interface Props {
  /** El enlace REAL de la reunión, al que va a entrar el bot. */
  url: string;
  /** La sala de Unify donde el bot deja transcripción y grabación. */
  roomKey: string;
  /** La plataforma detectada de la web (se traduce a las del bot). */
  platform: string;
  /** El idioma que se va a hablar, para el oído del bot. */
  lang: string;
  /** Título de la tarjeta (cambia según desde dónde se lo ofrece). */
  titulo?: string;
  /** La bajada que explica para qué sirve, en ese contexto. */
  descripcion?: string;
  /**
   * ZOOM SIN BOT. El servidor tiene Realtime Media Streams y la sala es
   * «zoom:<número>»: «mandar el bot» es pedirle a Zoom que transmita la
   * reunión a Unify. Nadie ve un participante extra. El bot visible queda
   * sólo para quien lo pide a propósito (una reunión de otra cuenta).
   */
  sinParticipante?: boolean;
  /**
   * SIN TARJETA. En la pantalla nueva de reunión externa esto ya vive DENTRO
   * de la tarjeta que pregunta quién está escuchando, así que acá sobra el
   * marco, el título y la bajada: queda el botón (principal, porque es la
   * salida que no depende de este aparato) y lo que tenga para contestar.
   */
  compacto?: boolean;
}

// EL BOT NUNCA ENTRA SOLO. Estuvo un tiempo mandándose automáticamente en
// iPhone y iPad (donde es la única forma de oír a los demás), y la respuesta
// de quien lo usa fue clara: «no quiero que se una automático». Un bot que
// entra a una reunión ajena sin que nadie lo pida es una decisión de la
// persona, no de la app. Queda el botón, bien a la vista, y la pantalla
// explica cuándo hace falta.

// Cuánto se espera a Zoom antes de sugerir qué revisar (la reunión puede no
// haber empezado todavía: no es un error) y cuándo dejar de sondear.
const SUGERIR_A_LOS_MS = 90_000;
const DEJAR_DE_SONDEAR_MS = 15 * 60_000;

// El botón que manda al bot. La plataforma se traduce a las que el bot
// entiende (jitsi / google-meet / zoom-web); el resto cae a jitsi, que el
// servidor también usa por defecto.
//
// Vive en su propio archivo porque se ofrece en DOS momentos distintos: antes
// de entrar (por si la persona no va a estar) y ADENTRO de la reunión desde el
// celular, donde el sistema no le presta el micrófono a Unify y el bot es la
// única forma de que quede la grabación y la transcripción completas.
export default function BotButton({
  url,
  roomKey,
  platform,
  lang,
  titulo,
  descripcion,
  compacto = false,
  sinParticipante = false,
}: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  // "ok" deja el botón en "mandado" (repetir el toque mandaba OTRO bot y,
  // peor, parecía que el primero nunca había salido); "error" grita en rojo;
  // "aviso" (ámbar) es "todavía nada, esto podés revisar" y deja reintentar.
  const [estado, setEstado] = useState<{ tipo: "ok" | "error" | "aviso"; texto: string } | null>(null);
  // Lo que contestó Zoom cuando se le pidió arrancar (p. ej. el código 2310).
  const [aviso, setAviso] = useState<string | null>(null);
  const [mandando, setMandando] = useState(false);
  // La persona pidió el bot VISIBLE a propósito (reunión de otra cuenta).
  const [modoVisible, setModoVisible] = useState(false);
  // Lo que el servidor dijo que hizo: manda sobre lo que la web suponía.
  const [modoRespuesta, setModoRespuesta] = useState<"bot" | "rtms" | null>(null);
  const escuchaSinBot = modoRespuesta ? modoRespuesta === "rtms" : sinParticipante && !modoVisible;
  const plataformaBot =
    platform === "google-meet" ? "google-meet" : platform === "zoom" ? "zoom-web" : platform === "jitsi" ? "jitsi" : "jitsi";

  const tituloFinal = titulo ?? (escuchaSinBot ? "¿No podés estar? Unify escucha sin aparecer" : "¿No podés estar?");
  const descripcionFinal =
    descripcion ??
    (escuchaSinBot
      ? "Zoom le transmite la reunión a Unify sin ningún participante extra: la transcripción y el resumen quedan en tu historial, estés o no."
      : "El bot entra por vos, graba, y te deja todo en el historial.");

  // La fase REAL del bot, sondeada del bridge. "Mandado ✓" solo decía que el
  // host aceptó el trabajo: si el bot moría contra la pantalla de Meet, la
  // persona quedaba esperando un bot muerto sin ninguna señal. Ahora el botón
  // cuenta el viaje (abriendo → pidió entrar → adentro) o el fallo con su
  // porqué. atPrevio evita confundir fases de un intento anterior: se compara
  // timestamp del servidor contra timestamp del servidor (sin líos de reloj).
  const [sondeoDesde, setSondeoDesde] = useState<number | null>(null);
  const atPrevioRef = useRef(0);
  const sugeridoRef = useRef(false);
  // El envío automático: una sola vez por sala y por carga de la pantalla.
  useEffect(() => {
    if (!sondeoDesde) return;
    let vivo = true;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const r = await fetch(`${SERVER_URL}/api/meet-bridge/${encodeURIComponent(roomKey)}/session`);
          if (!r.ok || !vivo) return;
          const d = (await r.json()) as { bot?: { fase: string; detalle: string | null; at: number } | null };
          const bot = d.bot;
          if (!vivo) return;
          const transcurrido = Date.now() - sondeoDesde;
          const fase = bot && bot.at > atPrevioRef.current ? bot.fase : null;
          if (fase === "fallo") {
            setEstado({
              tipo: "error",
              texto: `${escuchaSinBot ? "Zoom no pudo transmitir la reunión." : "El bot no pudo entrar."} ${bot?.detalle ?? ""}`.trim(),
            });
            setSondeoDesde(null);
          } else if (fase === "adentro") {
            setEstado({
              tipo: "ok",
              texto: escuchaSinBot
                ? "Unify está escuchando ✓ Sin participante extra: la transcripción queda en tu historial."
                : "El bot está adentro ✓ Grabando y transcribiendo: todo queda en tu historial.",
            });
            setSondeoDesde(null);
          } else if (fase === "esperando-admision") {
            setEstado({
              tipo: "ok",
              texto: "El bot ya pidió entrar: aceptalo desde la reunión (en Meet: Personas → Admitir).",
            });
          } else if (fase === "abriendo") {
            setEstado({
              tipo: "ok",
              texto: escuchaSinBot ? "Zoom está por transmitir la reunión a Unify…" : "El bot está abriendo la reunión…",
            });
          } else if (fase === "esperando-zoom" || (escuchaSinBot && !fase)) {
            // Zoom sin bot: la reunión puede no haber empezado. No es un error;
            // pasado un rato se dice qué revisar, y se sigue escuchando.
            if (transcurrido > DEJAR_DE_SONDEAR_MS) {
              setEstado({
                tipo: "aviso",
                texto:
                  "Pasaron 15 minutos sin que Zoom transmitiera la reunión. Cuando empiece, volvé a tocar el botón.",
              });
              setSondeoDesde(null);
            } else if (transcurrido > SUGERIR_A_LOS_MS && !sugeridoRef.current) {
              sugeridoRef.current = true;
              setEstado({
                tipo: "aviso",
                texto:
                  "Zoom todavía no avisó. Si la reunión ya empezó, revisá: que seas el anfitrión, que la app de Unify esté autorizada en tu Zoom y que el auto-inicio de Realtime Media Streams esté encendido en la configuración de la cuenta (Zoom Apps).",
              });
            } else if (!sugeridoRef.current) {
              setEstado({
                tipo: "ok",
                texto: "Esperando que la reunión empiece en Zoom. Cuando arranque, Unify la escucha sin aparecer.",
              });
            }
          } else if (!fase && transcurrido > 60_000) {
            setEstado({
              tipo: "error",
              texto:
                "El bot no dio señales en un minuto. El host del bot puede estar caído o con una versión vieja: probá de nuevo y, si sigue, avisanos.",
            });
            setSondeoDesde(null);
          }
        } catch {
          // red caída un tick: el próximo lo reintenta
        }
      })();
    }, 3000);
    return () => {
      vivo = false;
      window.clearInterval(timer);
    };
  }, [sondeoDesde, roomKey, escuchaSinBot]);

  async function mandar(visible = false) {
    setMandando(true);
    setEstado(null);
    setAviso(null);
    sugeridoRef.current = false;
    // La marca de "antes de este intento": cualquier fase más nueva es de ESTE bot.
    try {
      const r = await fetch(`${SERVER_URL}/api/meet-bridge/${encodeURIComponent(roomKey)}/session`);
      const d = r.ok ? ((await r.json()) as { bot?: { at: number } | null }) : null;
      atPrevioRef.current = d?.bot?.at ?? 0;
    } catch {
      atPrevioRef.current = 0;
    }
    const r = await dispatchBot({ url, roomKey, platform: plataformaBot, lang, ...(visible ? { visible: true } : {}) });
    setMandando(false);
    if (r.error) {
      setEstado({ tipo: "error", texto: r.error });
      return;
    }
    const rtms = r.modo === "rtms";
    setModoRespuesta(rtms ? "rtms" : "bot");
    setAviso(r.aviso ?? null);
    setEstado({
      tipo: "ok",
      texto:
        (r.message ?? (rtms ? "Zoom va a transmitir la reunión a Unify." : "El bot va en camino: puede tardar un minuto en aparecer.")) +
        (!rtms && plataformaBot === "google-meet" ? " Si Meet pide permiso para dejarlo entrar, aceptalo desde la reunión." : ""),
    });
    // Ya se está escuchando: no hay nada que sondear.
    if (rtms && r.estado === "escuchando") {
      setEstado({
        tipo: "ok",
        texto: r.message ?? "Unify está escuchando ✓ Sin participante extra: la transcripción queda en tu historial.",
      });
      return;
    }
    setSondeoDesde(Date.now());
  }

  const etiqueta = escuchaSinBot
    ? estado?.tipo === "ok"
      ? "Unify a la escucha ✓"
      : mandando
        ? "Avisando a Zoom…"
        : "Que Unify escuche por mí (sin aparecer)"
    : estado?.tipo === "ok"
      ? "Bot mandado ✓"
      : mandando
        ? "Mandando el bot…"
        : "Que entre el bot por mí";

  const etiquetaCompacta = escuchaSinBot
    ? estado?.tipo === "ok"
      ? "Unify ya está escuchando ✓"
      : mandando
        ? "Avisando a la reunión…"
        : "Que Unify escuche toda la reunión"
    : estado?.tipo === "ok"
      ? "Unify ya está escuchando ✓"
      : mandando
        ? "Entrando a la reunión…"
        : "Que Unify escuche toda la reunión";

  return (
    <div className={compacto ? "" : "mt-4 rounded-xl border border-ink-700 bg-ink-800/40 p-3"}>
      {!compacto && (
        <>
          <p className="text-sm font-medium text-strong">{tituloFinal}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">{descripcionFinal}</p>
        </>
      )}
      {/* SIN CUENTA TAMBIÉN SE MANDA. Antes acá había un «Iniciá sesión para
          que Unify escuche toda la reunión» EN LUGAR del botón: quien no
          tenía cuenta no podía hacer nada, ni siquiera escuchar su propia
          reunión. Reporte real: «no se puede transcribir ni mandar los
          subtítulos ni básicamente nada sin iniciar sesión, lo cual está
          mal».
          Lo único que de verdad necesita una cuenta es GUARDAR, así que eso
          es lo único que se dice -- y se dice ANTES, no como un botón que
          bloquea. */}
      <button
        type="button"
        onClick={() => void mandar(modoVisible)}
        disabled={mandando || estado?.tipo === "ok"}
        className={
          compacto
            ? "w-full rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-bold text-on-accent shadow-sm hover:bg-brand-600 disabled:opacity-60"
            : "mt-2.5 w-full rounded-xl border border-brand-500/50 px-4 py-2.5 text-sm font-semibold text-brand-200 hover:bg-brand-500/10 disabled:opacity-60"
        }
      >
        {compacto ? etiquetaCompacta : etiqueta}
      </button>
      {!user && (
        <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-warn">
          Sin cuenta, esta reunión <strong>no queda guardada</strong>: vas a leer los subtítulos y su
          traducción en vivo, pero al cerrar no van a estar en ningún historial.{" "}
          <button
            type="button"
            onClick={() => navigate("/ingresar")}
            className="font-semibold underline underline-offset-2 hover:text-strong"
          >
            Iniciá sesión o registrate
          </button>{" "}
          si la querés guardar.
        </p>
      )}
      {estado && (
        <p
          role="status"
          className={`mt-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
            estado.tipo === "error"
              ? "border-red-500/40 bg-red-500/10 text-danger"
              : estado.tipo === "aviso"
                ? "border-amber-500/40 bg-amber-500/10 text-warn"
                : "border-emerald-500/40 bg-emerald-500/10 text-ok"
          }`}
        >
          {estado.texto}
        </p>
      )}
      {aviso && <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">{aviso}</p>}
      {/* La salida para una reunión que Zoom no va a transmitir (de otra
          cuenta): el bot de siempre, pedido a propósito. Aparece recién cuando
          la escucha sin participante no dio señales, no antes. */}
      {sinParticipante && !modoVisible && user && estado?.tipo === "aviso" && (
        <button
          type="button"
          onClick={() => {
            setModoVisible(true);
            setModoRespuesta(null);
            setEstado(null);
            setAviso(null);
            setSondeoDesde(null);
          }}
          className="mt-2 text-xs font-medium text-ink-300 underline decoration-ink-600 underline-offset-2 hover:text-strong"
        >
          ¿La reunión es de otra cuenta de Zoom? Mandar el bot visible en cambio
        </button>
      )}
    </div>
  );
}
