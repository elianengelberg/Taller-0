import { useEffect, useState } from "react";
import { TranscriptLine } from "../types";

export default function LiveCaption({ line }: { line: TranscriptLine | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!line) return;
    setVisible(true);
    const timeout = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(timeout);
  }, [line]);

  if (!line || !visible) return null;

  return (
    <div className="caption-fade pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
      <div className="max-w-xl rounded-xl bg-black/70 px-4 py-2 text-center text-sm text-white shadow-soft">
        <span className="font-semibold text-brand-300">{line.speakerName}: </span>
        {line.text}
      </div>
    </div>
  );
}
