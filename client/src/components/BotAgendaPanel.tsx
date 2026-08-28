import { useEffect, useState } from "react";
import { BotAgenda, fetchBotAgenda, saveBotAgenda } from "../lib/api";

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
    } else {
      setAviso(r.error ?? "No se pudo guardar.");
    }
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

      <div className="mt-3">
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
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setComoSacarlo((v) => !v)}
          className="mt-2 text-xs text-brand-300 underline"
        >
          ¿Dónde consigo ese link? (te muestro paso a paso)
        </button>
        {comoSacarlo && (
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-ink-400">
            <li>En una compu, entrá a <strong>calendar.google.com</strong>.</li>
            <li>A la izquierda está tu calendario con tu nombre. Dejá el mouse encima, tocá los <strong>tres puntitos</strong> y después <strong>Configuración</strong>.</li>
            <li>Bajá hasta donde dice <strong>«Dirección secreta en formato iCal»</strong> y tocá el botón de copiar.</li>
            <li>Volvé acá, pegá el link arriba y tocá <strong>Guardar</strong>. Listo, eso es todo.</li>
          </ol>
        )}
        <p className="mt-2 text-xs text-ink-500">¿Usás Outlook? Conectalo arriba y ya queda.</p>
      </div>

      {aviso && <p className="mt-3 text-xs text-ink-300">{aviso}</p>}
    </div>
  );
}
