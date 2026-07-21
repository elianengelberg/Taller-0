import { useEffect, useRef, useState } from "react";
import { CloseIcon, RecordIcon } from "./icons";

// Small, non-invasive prompt shown just after joining, bottom-right near the
// record button: "¿Grabar la reunión? Empieza sola en Ns". If the person
// neither starts it manually nor declines within the countdown, recording
// begins automatically. Declining ("No") cancels the auto-start.
export default function RecordAutoPrompt({
  seconds = 10,
  onStart,
  onDecline,
}: {
  seconds?: number;
  // auto=true when the countdown ran out; false when the user pressed "Grabar".
  onStart: (auto: boolean) => void;
  onDecline: () => void;
}) {
  const [left, setLeft] = useState(seconds);
  // The parent (Meeting) re-renders every second for its elapsed-time pill, so
  // `onStart` gets a new identity each render. Keep it in a ref and run the
  // countdown interval ONCE on mount, or the effect would restart the timer
  // every render and the countdown would never actually tick down.
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;

  useEffect(() => {
    const timer = setInterval(() => {
      setLeft((n) => {
        if (n <= 1) {
          clearInterval(timer);
          onStartRef.current(true); // auto-start when the countdown runs out
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="pointer-events-auto fixed bottom-24 right-4 z-40 w-72 rounded-2xl border border-brand-500/40 bg-ink-900/95 p-3 shadow-top backdrop-blur-md sm:bottom-28">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-red-600/90">
            <RecordIcon className="h-4 w-4 animate-pulse text-on-accent" />
          </span>
          <p className="text-sm font-semibold text-strong">¿Grabar la reunión?</p>
        </div>
        <button
          type="button"
          onClick={onDecline}
          aria-label="No grabar"
          className="rounded-full p-1 text-ink-400 hover:bg-ink-700 hover:text-strong"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
        Si no elegís, la grabación empieza sola en{" "}
        <span className="font-semibold text-brand-300">{left}s</span>. También podés iniciarla o
        cancelarla con el botón <span className="font-medium text-ink-300">Grabar</span>.
      </p>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => onStart(false)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-brand-600"
        >
          <RecordIcon className="h-3.5 w-3.5" />
          Grabar ahora
        </button>
        <button
          type="button"
          onClick={onDecline}
          className="rounded-lg bg-ink-800 px-3 py-1.5 text-xs font-medium text-ink-200 hover:bg-ink-700"
        >
          No
        </button>
      </div>
    </div>
  );
}
