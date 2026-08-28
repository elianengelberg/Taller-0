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
}

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
  titulo = "¿No podés estar?",
  descripcion = "El bot entra por vos, graba, y te deja todo en el historial.",
}: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  // "ok" deja el botón en "mandado" (repetir el toque mandaba OTRO bot y,
  // peor, parecía que el primero nunca había salido); "error" grita en rojo.
  const [estado, setEstado] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [mandando, setMandando] = useState(false);
  const plataformaBot =
    platform === "google-meet" ? "google-meet" : platform === "zoom" ? "zoom-web" : platform === "jitsi" ? "jitsi" : "jitsi";

  // La fase REAL del bot, sondeada del bridge. "Mandado ✓" solo decía que el
  // host aceptó el trabajo: si el bot moría contra la pantalla de Meet, la
  // persona quedaba esperando un bot muerto sin ninguna señal. Ahora el botón
  // cuenta el viaje (abriendo → pidió entrar → adentro) o el fallo con su
  // porqué. atPrevio evita confundir fases de un intento anterior: se compara
  // timestamp del servidor contra timestamp del servidor (sin líos de reloj).
  const [sondeoDesde, setSondeoDesde] = useState<number | null>(null);
  const atPrevioRef = useRef(0);
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
          if (bot && bot.at > atPrevioRef.current) {
            if (bot.fase === "fallo") {
              setEstado({ tipo: "error", texto: `El bot no pudo entrar. ${bot.detalle ?? ""}`.trim() });
              setSondeoDesde(null);
            } else if (bot.fase === "adentro") {
              setEstado({
                tipo: "ok",
                texto: "El bot está adentro ✓ Grabando y transcribiendo: todo queda en tu historial.",
              });
              setSondeoDesde(null);
            } else if (bot.fase === "esperando-admision") {
              setEstado({
                tipo: "ok",
                texto: "El bot ya pidió entrar: aceptalo desde la reunión (en Meet: Personas → Admitir).",
              });
            } else if (bot.fase === "abriendo") {
              setEstado({ tipo: "ok", texto: "El bot está abriendo la reunión…" });
            }
          } else if (Date.now() - sondeoDesde > 60_000) {
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
  }, [sondeoDesde, roomKey]);

  async function mandar() {
    setMandando(true);
    setEstado(null);
    // La marca de "antes de este intento": cualquier fase más nueva es de ESTE bot.
    try {
      const r = await fetch(`${SERVER_URL}/api/meet-bridge/${encodeURIComponent(roomKey)}/session`);
      const d = r.ok ? ((await r.json()) as { bot?: { at: number } | null }) : null;
      atPrevioRef.current = d?.bot?.at ?? 0;
    } catch {
      atPrevioRef.current = 0;
    }
    const r = await dispatchBot({ url, roomKey, platform: plataformaBot, lang });
    setMandando(false);
    if (r.error) setEstado({ tipo: "error", texto: r.error });
    else {
      setEstado({
        tipo: "ok",
        texto:
          (r.message ?? "El bot va en camino: puede tardar un minuto en aparecer.") +
          (plataformaBot === "google-meet"
            ? " Si Meet pide permiso para dejarlo entrar, aceptalo desde la reunión."
            : ""),
      });
      setSondeoDesde(Date.now());
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-ink-700 bg-ink-800/40 p-3">
      <p className="text-sm font-medium text-strong">{titulo}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-400">{descripcion}</p>
      {/* El bot graba A TU NOMBRE (la reunión queda en tu historial): sin
          sesión, el servidor lo rechaza -- mejor decirlo ANTES del toque que
          fallar en silencio, que es lo que pasaba. */}
      {!user ? (
        <button
          type="button"
          onClick={() => navigate("/ingresar")}
          className="mt-2.5 w-full rounded-xl border border-brand-500/50 px-4 py-2.5 text-sm font-semibold text-brand-200 hover:bg-brand-500/10"
        >
          Iniciá sesión para mandar el bot
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void mandar()}
          disabled={mandando || estado?.tipo === "ok"}
          className="mt-2.5 w-full rounded-xl border border-brand-500/50 px-4 py-2.5 text-sm font-semibold text-brand-200 hover:bg-brand-500/10 disabled:opacity-60"
        >
          {estado?.tipo === "ok" ? "Bot mandado ✓" : mandando ? "Mandando el bot…" : "Que entre el bot por mí"}
        </button>
      )}
      {estado && (
        <p
          className={`mt-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
            estado.tipo === "error"
              ? "border-red-500/40 bg-red-500/10 text-red-300"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
          }`}
        >
          {estado.texto}
        </p>
      )}
    </div>
  );
}
