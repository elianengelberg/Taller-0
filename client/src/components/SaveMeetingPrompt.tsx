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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className={`${cardClass} max-w-sm text-center`}>
        <h2 className="text-lg font-bold text-white">¿Guardar esta reunión?</h2>
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
