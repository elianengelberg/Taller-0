import { useEffect, useState } from "react";
import { TranscriptLine } from "../types";
import { GlobeIcon } from "./icons";

interface Props {
  line: TranscriptLine | null;
  translatedText?: string;
}

export default function LiveCaption({ line, translatedText }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!line) return;
    setVisible(true);
    const timeout = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(timeout);
  }, [line]);

  if (!line || !visible) return null;

  const showingTranslation = Boolean(translatedText);

  return (
    <div className="caption-fade pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
      <div className="max-w-xl rounded-xl bg-black/70 px-4 py-2 text-center text-sm text-white shadow-soft">
        <span className="font-semibold text-brand-300">{line.speakerName}: </span>
        {showingTranslation ? translatedText : line.text}
        {showingTranslation && (
          <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-[10px] font-medium uppercase tracking-wide text-brand-300">
            <GlobeIcon className="h-3 w-3" />
            traducido
          </span>
        )}
      </div>
    </div>
  );
}
