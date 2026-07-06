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
    <div className="caption-fade pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
      <div className="max-w-2xl rounded-2xl bg-black/75 px-4 py-2.5 text-center shadow-soft backdrop-blur-md ring-1 ring-white/10">
        <p className="text-sm leading-snug text-white sm:text-base">
          <span className="font-semibold text-brand-300">{activeLine.speakerName}: </span>
          {showingTranslation ? translatedText : activeLine.text}
        </p>
        {/* When translated, keep the original visible underneath (muted) so
            people can follow both what was said and its translation. */}
        {showingTranslation && (
          <p className="mt-1 flex items-center justify-center gap-1.5 text-xs leading-snug text-white/55">
            <GlobeIcon className="h-3 w-3 shrink-0 text-brand-300/80" />
            <span className="italic">{activeLine.text}</span>
          </p>
        )}
      </div>
    </div>
  );
}
