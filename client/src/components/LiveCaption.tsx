import { useEffect, useState } from "react";
import { TranscriptLine } from "../types";
import { GlobeIcon } from "./icons";

interface CaptionLine {
  speakerName: string;
  text: string;
}

interface Props {
  line: TranscriptLine | null;
  translatedText?: string;
  // The local speaker's own in-progress utterance, updated live as they
  // talk. Takes priority over `line` while present -- it's always more
  // current than whatever last finished the full cleanup+translate round
  // trip.
  localInterim?: CaptionLine | null;
}

export default function LiveCaption({ line, translatedText, localInterim }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (localInterim) {
      setVisible(true);
      return;
    }
    if (!line) return;
    setVisible(true);
    const timeout = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(timeout);
  }, [line, localInterim]);

  const activeLine: CaptionLine | null = localInterim ?? line;
  if (!activeLine || !visible) return null;

  const showingTranslation = !localInterim && Boolean(translatedText);

  return (
    <div className="caption-fade pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
      <div className="max-w-xl rounded-xl bg-black/70 px-4 py-2 text-center text-sm text-white shadow-soft">
        <span className="font-semibold text-brand-300">{activeLine.speakerName}: </span>
        {showingTranslation ? translatedText : activeLine.text}
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
