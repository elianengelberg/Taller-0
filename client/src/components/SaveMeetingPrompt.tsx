import Button from "./Button";
import { cardClass } from "../lib/ui";

interface Props {
  onSave: () => void;
  onSkip: () => void;
}

// Shown right when a guest (no account) leaves a meeting: their transcript
// and chat were being recorded the whole time (see decisions.md), but with
// no owner it would never show up anywhere -- this is the one chance to
// attach it to an account before it's effectively gone.
export default function SaveMeetingPrompt({ onSave, onSkip }: Props) {
  return (
    // Por encima de TODO, incluida la tarjeta de error del SDK de Zoom (que se
    // pone al tope del z-index para tapar los diálogos del propio Zoom): con
    // z-50 este aviso quedaba escondido detrás y «Salir» parecía no hacer nada.
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/70 px-4"
      style={{ zIndex: 2147483647 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="guardar-reunion-titulo"
    >
      <div className={`${cardClass} max-w-sm text-center`}>
        <h2 id="guardar-reunion-titulo" className="text-lg font-bold text-strong">¿Guardar esta reunión?</h2>
        <p className="mt-2 text-sm text-ink-300">
          Iniciá sesión o creá una cuenta para guardar la transcripción y el chat en tu
          historial. Si no, se pierde en cuanto cierres esta pestaña.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <Button onClick={onSave}>Guardar (iniciar sesión)</Button>
          <Button variant="secondary" onClick={onSkip}>
            No, gracias
          </Button>
        </div>
      </div>
    </div>
  );
}
