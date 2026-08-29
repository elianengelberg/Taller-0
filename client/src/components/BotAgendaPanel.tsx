import { useEffect, useState } from "react";
import BotRepeticiones from "./BotRepeticiones";
import { BotAgenda, fetchBotAgenda, probarBotAgenda, PruebaCalendario, saveBotAgenda } from "../lib/api";

// La tarjeta del "piloto automático": el bot entra SOLO a las reuniones del
// calendario, sin que la persona toque nada. Se enciende una vez y se pega la
// dirección iCal secreta de Google Calendar (o se usa el Outlook ya conectado,
// que maneja CalendarPanel). Es lo que hace que "tengo una reunión en el
// calendario -> el bot ya está ahí" funcione sin intervención.
export default function BotAgendaPanel() {
  const [cfg, setCfg] = useState<BotAgenda | null>(null);
  const [ics, setIcs] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [comoSacarlo, setComoSacarlo] = useState(false);
  // El resultado de LEER el calendario de verdad (no "guardado": "anda").
  const [probando, setProbando] = useState(false);
  const [prueba, setPrueba] = useState<PruebaCalendario | null>(null);

  useEffect(() => {
    fetchBotAgenda().then((c) => {
      setCfg(c);
      setIcs(c.icsUrl ?? "");
    });
  }, []);

  if (!cfg) return null;

  async function guardar(next: Partial<BotAgenda>) {
    const actual = cfg;
    if (!actual) return;
    const auto = next.auto ?? actual.auto;
    const icsUrl = (next.icsUrl !== undefined ? (next.icsUrl ?? "") : ics).trim() || null;
    setGuardando(true);
    setAviso(null);
    const r = await saveBotAgenda(auto, icsUrl);
    setGuardando(false);
    if (r.ok) {
      setCfg({ ...actual, auto, icsUrl });
      setAviso(auto ? "Listo: el bot va a entrar solo a tus próximas reuniones." : "Piloto automático apagado.");
      // Guardar y comprobar son la misma intención: se prueba solo.
      if (icsUrl) void probar(icsUrl);
    } else {
      setAviso(r.error ?? "No se pudo guardar.");
    }
  }

  async function probar(url: string) {
    setProbando(true);
    setPrueba(null);
    setPrueba(await probarBotAgenda(url));
    setProbando(false);
  }

  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-800/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-strong">Grabá tus reuniones sin mover un dedo</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            Conectá tu calendario y el asistente entra solo a cada reunión. El video y el resumen
            quedan acá. Si la reunión no arranca, espera hasta 30 minutos y se retira solo.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={cfg.auto}
          disabled={guardando || !cfg.botEnabled}
          onClick={() => void guardar({ auto: !cfg.auto })}
          className={`mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${
            cfg.auto ? "bg-brand-500" : "bg-ink-600"
          } disabled:opacity-50`}
        >
          <span
            className={`block h-5 w-5 rounded-full bg-white transition-transform ${
              cfg.auto ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {!cfg.botEnabled && (
        <p className="mt-3 rounded-lg bg-ink-900/60 px-3 py-2 text-xs text-ink-400">
          El bot todavía no está habilitado en el servidor. Cuando lo enciendan, vas a poder
          activar el piloto automático acá.
        </p>
      )}

      <BotRepeticiones botEnabled={cfg.botEnabled} />

      <div className="mt-4 border-t border-ink-700 pt-4">
        <h4 className="text-xs font-semibold text-ink-200">…o conectá tu calendario entero</h4>
        <p className="mt-1 mb-2 text-xs leading-relaxed text-ink-400">
          El bot entra a TODAS las reuniones agendadas que tengan un link adentro. Se saca de la
          web de Google Calendar en una computadora (en la app del celular no aparece).
        </p>
        <label className="text-xs font-medium text-ink-300">
          El link de tu calendario de Google
        </label>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row">
          <input
            type="url"
            value={ics}
            onChange={(e) => setIcs(e.target.value)}
            placeholder="https://calendar.google.com/calendar/ical/….../basic.ics"
            className="min-w-0 flex-1 rounded-xl border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-strong placeholder:text-ink-500"
          />
          <button
            type="button"
            onClick={() => void guardar({})}
            disabled={guardando || !cfg.botEnabled}
            className="rounded-xl border border-brand-500/50 px-4 py-2 text-sm font-semibold text-brand-200 hover:bg-brand-500/10 disabled:opacity-50"
          >
            {guardando ? "Guardando…" : "Guardar y probar"}
          </button>
        </div>

        {/* La comprobación: lo que separa "guardado" de "quedó andando". */}
        {(probando || prueba) && (
          <div
            className={`mt-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
              probando
                ? "border-ink-600 bg-ink-900/60 text-ink-300"
                : prueba?.ok
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-200"
            }`}
          >
            {probando ? (
              "Leyendo tu calendario…"
            ) : prueba?.ok ? (
              prueba.proximas && prueba.proximas.length > 0 ? (
                <>
                  <p className="font-semibold">
                    Conectado ✓ El bot va a entrar solo a estas {prueba.proximas.length === 1 ? "reunión" : "reuniones"}:
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {prueba.proximas.map((p) => (
                      <li key={`${p.subject}-${p.startMs}`}>
                        · {p.subject} — {new Date(p.startMs).toLocaleString([], {
                          weekday: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <p className="font-semibold">Leímos tu calendario ✓ pero no hay reuniones con link por delante.</p>
                  <p className="mt-1">
                    {prueba.totalEventos
                      ? `Tiene ${prueba.totalEventos} eventos, pero ninguno de los próximos días trae un enlace de Meet, Zoom o Jitsi adentro. `
                      : "Está vacío. "}
                    El bot entra por el enlace: agregalo al evento (con «Agregar Google Meet», o pegándolo
                    en la descripción) y esto se va a llenar solo.
                  </p>
                </>
              )
            ) : (
              prueba?.error
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => setComoSacarlo((v) => !v)}
          className="mt-2 text-xs text-brand-300 underline"
        >
          ¿Dónde consigo ese link? (te muestro paso a paso)
        </button>
        {comoSacarlo && (
          <div className="mt-2 space-y-3 text-xs leading-relaxed text-ink-400">
            {/* La dirección secreta NO existe en la app de Google Calendar del
                teléfono ni del iPad: sólo en la web de escritorio. Decirlo
                primero evita la búsqueda infinita de un botón que no está. */}
            <p className="rounded-lg border border-dashed border-ink-600 px-3 py-2">
              <b className="text-ink-200">Ojo:</b> este link no aparece en la <b>app</b> de Google
              Calendar (ni en iPad ni en celular). Está sólo en la <b>web</b> de Google Calendar.
            </p>
            <div>
              <p className="font-medium text-ink-200">En una computadora</p>
              <ol className="mt-1 list-decimal space-y-1 pl-5">
                <li>Entrá a <strong>calendar.google.com</strong>.</li>
                <li>A la izquierda está tu calendario con tu nombre. Dejá el mouse encima, tocá los <strong>tres puntitos</strong> y después <strong>Configuración y uso compartido</strong>.</li>
                <li>Bajá del todo, hasta <strong>«Integrar calendario»</strong>.</li>
                <li>Copiá la <strong>«Dirección secreta en formato iCal»</strong> (termina en <code>.ics</code>).</li>
                <li>Pegala acá arriba y tocá <strong>Guardar y probar</strong>.</li>
              </ol>
            </div>
            <div>
              <p className="font-medium text-ink-200">Desde el iPad o el celular (sin computadora)</p>
              <ol className="mt-1 list-decimal space-y-1 pl-5">
                <li>Abrí <strong>Safari</strong> (no la app de Calendar) y entrá a <strong>calendar.google.com</strong>.</li>
                <li>Tocá <strong>aA</strong> en la barra de direcciones y elegí <strong>«Solicitar sitio web para computadora»</strong>. Sin esto, la página no muestra la configuración.</li>
                <li>Tocá el <strong>engranaje</strong> arriba a la derecha → <strong>Configuración</strong>.</li>
                <li>En la lista de la izquierda, tocá el calendario <strong>con tu nombre</strong>.</li>
                <li>Bajá hasta <strong>«Integrar calendario»</strong> y copiá la <strong>«Dirección secreta en formato iCal»</strong>.</li>
                <li>Volvé acá, pegala arriba y tocá <strong>Guardar y probar</strong>.</li>
              </ol>
            </div>
          </div>
        )}
        <p className="mt-2 text-xs text-ink-500">¿Usás Outlook? Conectalo arriba y ya queda.</p>
      </div>

      {aviso && <p className="mt-3 text-xs text-ink-300">{aviso}</p>}
    </div>
  );
}
