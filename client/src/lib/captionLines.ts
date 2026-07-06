import { CaptionEntry } from "../components/LiveCaption";
import { TranscriptLine } from "../types";

// Builds the live-caption stack: the most recent finalized line for each of
// the last `maxSpeakers` distinct speakers, oldest first. This is what lets
// several people talking at once each keep their own caption row (Diego at the
// bottom, Elian above, Pedro above that) instead of a single caption bubble
// flickering as it's overwritten. LiveCaption then expires each row on its own
// timer, so when only one person is talking only one row is shown.
export function recentCaptionEntries(
  transcript: TranscriptLine[],
  getTranslation: (lineId: string) => string | undefined,
  maxSpeakers = 3
): CaptionEntry[] {
  const seen = new Set<string>();
  const picked: TranscriptLine[] = [];
  for (let i = transcript.length - 1; i >= 0 && picked.length < maxSpeakers; i--) {
    const line = transcript[i];
    if (seen.has(line.speakerId)) continue;
    seen.add(line.speakerId);
    picked.push(line);
  }
  picked.reverse(); // newest was pushed first -> flip to oldest-first for top->bottom
  return picked.map((line) => ({
    id: line.id,
    speakerId: line.speakerId,
    speakerName: line.speakerName,
    text: line.text,
    translatedText: getTranslation(line.id),
  }));
}
