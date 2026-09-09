import { GlobeIcon, LogoutIcon, PeopleIcon } from "./icons";
import Logo from "./Logo";
import { LANGUAGES } from "../lib/languages";
import { AUTO_LANG, ORIGINAL_LANG } from "../hooks/useLineTranslations";

// LA CABECERA DE UNA REUNIÓN EXTERNA. Dos renglones, y nada más:
//   1) de qué reunión se trata y cómo salir (con la palabra «Salir» escrita,
//      no un iconito perdido entre otros seis: irse era de lo que más costaba);
//   2) los dos idiomas, que es a lo que la persona vino.
// Todo lo demás vive en la barra de abajo o en Ajustes.
export default function BarraDeReunion({
  sala,
  personas,
  onSalir,
  onInvitar,
  leesEn,
  onLeesEn,
  autoLabel,
  hablanEn,
  onHablanEn,
  hablanEnEfectivo,
  compacto = false,
}: {
  /** «Google Meet · abc-defg-hij» */
  sala: string;
  personas: number;
  onSalir: () => void;
  onInvitar: () => void;
  leesEn: string;
  onLeesEn: (valor: string) => void;
  /** A qué idioma resuelve «Automático» (el tuyo). */
  autoLabel?: string;
  hablanEn: string;
  onHablanEn?: ((valor: string) => void) | null;
  hablanEnEfectivo?: string;
  compacto?: boolean;
}) {
  return (
    <header className="border-b border-ink-800 bg-ink-900/95 shadow-soft backdrop-blur-md">
      <div
        className={`flex items-center gap-2 px-3 sm:px-5 ${compacto ? "py-1" : "py-2"}`}
      >
        {/* LA SALIDA, PRIMERO Y CON SU NOMBRE. Sale de Unify; la llamada sigue
            en su app, y eso lo dice el propio botón. */}
        <button
          type="button"
          onClick={onSalir}
          className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-sm font-semibold text-ink-200 hover:bg-ink-800 hover:text-strong"
          title="Salís de Unify. La reunión sigue abierta en su app."
        >
          <LogoutIcon className="h-4 w-4" />
          Salir
        </button>
        <span className="hidden h-5 w-px shrink-0 bg-white/10 sm:block" aria-hidden />
        <Logo />
        <span className="min-w-0 truncate text-xs text-ink-400">{sala}</span>
        <button
          type="button"
          onClick={onInvitar}
          className="ml-auto flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl border border-ink-600 px-3 text-sm font-semibold text-ink-100 hover:border-brand-400 hover:text-strong"
          // El número solo no dice de qué es: el nombre accesible lo dice
          // («2 en Unify»), que es además lo que leen un lector de pantalla y
          // las pruebas.
          aria-label={`${personas} en Unify — invitar a los demás a esta reunión`}
          title="Quién está en Unify, e invitar a los demás a esta reunión"
        >
          <PeopleIcon className="h-4 w-4" />
          {personas}
        </button>
      </div>

      {/* LOS IDIOMAS, SIEMPRE A LA VISTA. Es lo que la gente busca y lo que
          hace que la pantalla sirva: no se esconde en ningún menú. */}
      <div
        className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-ink-800/80 px-3 sm:px-5 ${
          compacto ? "py-1" : "py-1.5"
        }`}
      >
        <label className="flex min-h-[36px] items-center gap-2">
          <GlobeIcon className="h-4 w-4 shrink-0 text-brand-300" />
          <span className="whitespace-nowrap text-xs font-medium text-ink-300">Lo leés en</span>
          <select
            value={leesEn}
            onChange={(e) => onLeesEn(e.target.value)}
            aria-label="Traducir los subtítulos a"
            title="El idioma en el que VOS leés los subtítulos"
            className="max-w-[13rem] rounded-lg border border-ink-500 bg-ink-800 px-2 py-1 text-sm font-medium text-strong focus:border-brand-400 focus:outline-none"
          >
            <option value={AUTO_LANG}>{autoLabel ? `Automático (${autoLabel})` : "Automático"}</option>
            <option value={ORIGINAL_LANG}>Sin traducir</option>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        {onHablanEn && (
          <label className="flex min-h-[36px] items-center gap-2">
            <span className="whitespace-nowrap text-xs font-medium text-ink-300">Hablan en</span>
            <select
              value={hablanEn}
              onChange={(e) => onHablanEn(e.target.value)}
              aria-label="Idioma en el que hablan los demás"
              title="El idioma en el que hablan las demás personas (lo que Unify escucha)"
              className="max-w-[13rem] rounded-lg border border-ink-500 bg-ink-800 px-2 py-1 text-sm font-medium text-strong focus:border-brand-400 focus:outline-none"
            >
              <option value="">{hablanEnEfectivo ? `Automático (${hablanEnEfectivo})` : "Automático"}</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </header>
  );
}
