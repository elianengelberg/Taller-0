import { useEffect, useRef, useState } from "react";
import { GlobeIcon, PeopleIcon, ShareIcon } from "./icons";
import TextoGrandeToggle from "./TextoGrandeToggle";
import { LANGUAGES } from "../lib/languages";
import { AUTO_LANG, ORIGINAL_LANG } from "../hooks/useLineTranslations";

interface Props {
  /** Cuántas personas están en la capa de Unify (no en la reunión externa). */
  participantCount: number;
  connected: boolean;
  targetLangChoice: string;
  onTargetLangChange: (value: string) => void;
  /** Enlace para que los demás abran ESTA misma reunión en Unify. */
  inviteUrl: string;
  roomLabel: string;
  /** Abre/cierra la ventanita de subtítulos flotantes; null si el navegador no puede. */
  onFlotantes?: (() => void) | null;
  flotantesActivo?: boolean;
  /** El idioma al que resuelve "Automático" (el que hablás), para mostrarlo. */
  autoLabel?: string;
}

// Dock de estado, arriba a la derecha, sobre la reunión externa.
//
// Concentra las dos cosas que la gente busca y no encontraba: en qué idioma ve
// los subtítulos, y cómo hacer que los demás aparezcan. Lo segundo es lo más
// importante de toda la pantalla: en una reunión externa, el navegador solo
// puede escuchar TU micrófono, así que la única forma de tener las voces de los
// demás es que ellos también abran Unify. Hasta que eso pase, el dock lo dice.
export default function CompanionDock({
  participantCount,
  connected,
  targetLangChoice,
  onTargetLangChange,
  inviteUrl,
  roomLabel,
  onFlotantes,
  flotantesActivo,
  autoLabel,
}: Props) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const alone = participantCount <= 1;

  useEffect(() => {
    if (!inviteOpen) return;
    function onPointer(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setInviteOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setInviteOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [inviteOpen]);

  async function share() {
    const text = `Sumate a la capa de Unify de esta reunión para que se transcriba también tu voz: ${inviteUrl}`;
    // En celular/tablet el menú nativo es lo más rápido; en escritorio, copiar.
    if (navigator.share) {
      try {
        await navigator.share({ title: "Unify", text, url: inviteUrl });
        return;
      } catch {
        /* cancelado: seguimos con el copiado */
      }
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* sin portapapeles: el enlace igual está a la vista para copiarlo a mano */
    }
  }

  return (
    <div ref={boxRef} className="pointer-events-auto absolute right-3 top-3 z-20 flex flex-col items-end gap-2">
      {/* MÁS GRANDE Y MÁS OBVIO. Estos controles (traducir, flotantes) son de
          lo más usado y estaban en letra chica con botones finitos: quien no
          es de tecnología ni los veía. Suben de talle -- texto sm, botones con
          altura de dedo -- sin cambiar la estética ni un texto. */}
      <div className="flex flex-wrap items-center justify-end gap-3 rounded-2xl border border-white/10 bg-ink-900/85 px-3.5 py-2 shadow-soft backdrop-blur-md sm:rounded-full">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${connected ? "bg-accent-green" : "bg-amber-400"}`}
          aria-hidden
        />
        <span className="whitespace-nowrap text-sm font-medium text-ink-100">
          <span className="font-bold text-strong">Unify</span>
          <span className="hidden sm:inline">: {connected ? "Companion activo" : "Reconectando…"}</span>
        </span>

        <span className="hidden h-5 w-px bg-white/10 sm:block" aria-hidden />

        {/* Visible SIEMPRE y con texto (era un iconito escondido en pantallas
            chicas): acceder a la traducción en vivo es de lo más usado. El
            aria-label del select conserva el nombre accesible completo. */}
        <label className="flex min-h-[40px] items-center gap-2">
          <GlobeIcon className="h-4 w-4 shrink-0 text-brand-300" />
          <span className="hidden whitespace-nowrap text-sm font-medium text-ink-200 sm:inline">Traducir a</span>
          <select
            value={targetLangChoice}
            onChange={(e) => onTargetLangChange(e.target.value)}
            aria-label="Traducir los subtítulos a"
            className="max-w-[9.5rem] truncate rounded-lg border border-ink-500 bg-ink-800 px-2.5 py-1.5 text-sm font-medium text-strong focus:border-brand-400 focus:outline-none"
            title="Idioma en el que ves los subtítulos"
          >
            {/* Con el idioma resuelto a la vista: "Automático" dejaba la duda
                de A QUÉ traduce; ahora se lee "Automático (Español...)". */}
            <option value={AUTO_LANG}>{autoLabel ? `Automático (${autoLabel})` : "Automático"}</option>
            <option value={ORIGINAL_LANG}>Sin traducir</option>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        {onFlotantes && (
          <button
            type="button"
            onClick={onFlotantes}
            title="Una ventanita con los subtítulos que queda SIEMPRE encima: ideal cuando comparten pantalla o la reunión está en otra app"
            className={`flex min-h-[40px] items-center gap-2 whitespace-nowrap rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
              flotantesActivo
                ? "border-accent-green/50 bg-accent-green/15 text-accent-green"
                : "border-transparent bg-brand-500 text-on-accent shadow-sm hover:bg-brand-600"
            }`}
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
              <rect x="1.5" y="3.5" width="17" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
              <rect x="9.5" y="9.5" width="7" height="5" rx="1.2" fill="currentColor" />
            </svg>
            {flotantesActivo ? "Flotantes ✓" : "Subtítulos flotantes"}
          </button>
        )}

        <span className="hidden h-5 w-px bg-white/10 sm:block" aria-hidden />

        <TextoGrandeToggle />

        <span className="hidden h-5 w-px bg-white/10 sm:block" aria-hidden />

        <button
          type="button"
          onClick={() => setInviteOpen((v) => !v)}
          aria-expanded={inviteOpen}
          className={`flex min-h-[40px] items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors ${
            alone ? "bg-brand-500 text-on-accent hover:bg-brand-600" : "border border-ink-600 text-ink-100 hover:bg-white/10"
          }`}
          title="Invitar a los demás a la capa de Unify"
        >
          <PeopleIcon className="h-4 w-4" />
          {participantCount}
        </button>
      </div>

      {/* Cuando estás solo, el aviso es la información más útil de la pantalla:
          explica por qué solo se transcribe tu voz y cómo cambiarlo. */}
      {alone && !inviteOpen && (
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          // En el teléfono este recordatorio se apilaba con los carteles de
          // grabación y el botón de entrar a la reunión: ahí se lo guarda (la
          // pantalla ya explica lo mismo) y queda el contador 👤 para abrirlo.
          className="hidden max-w-[17rem] rounded-xl border border-ink-600 bg-ink-800 px-3 py-2 text-left text-[11px] leading-snug text-ink-200 shadow-soft hover:border-brand-400 sm:block"
        >
          Por ahora solo se transcribe <b>tu voz</b>. Para sumar la de los demás,
          <span className="font-semibold"> invitalos a Unify</span>.
        </button>
      )}

      {inviteOpen && (
        <div className="w-[19rem] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-ink-700 bg-ink-900/95 p-3.5 shadow-soft backdrop-blur-md">
          <p className="text-sm font-semibold text-strong">Sumá a los demás</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-300">
            Cada navegador solo puede escuchar el micrófono de quien lo usa. Si tus compañeros
            abren este enlace, sus voces entran a la misma transcripción y todos ven los subtítulos
            traducidos.
          </p>
          <p className="mt-2 truncate rounded-lg bg-ink-800 px-2.5 py-1.5 font-mono text-[11px] text-ink-300">
            {inviteUrl}
          </p>
          <button
            type="button"
            onClick={share}
            className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-500 px-3 py-2 text-sm font-semibold text-on-accent hover:bg-brand-600"
          >
            <ShareIcon className="h-4 w-4" />
            {copied ? "¡Enlace copiado!" : "Compartir el enlace"}
          </button>
          <p className="mt-2 text-[11px] text-ink-500">{roomLabel}</p>
        </div>
      )}
    </div>
  );
}
