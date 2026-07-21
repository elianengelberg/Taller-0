// Groups consecutive transcript entries from the same speaker into
// paragraph-sized blocks (Otter/Fireflies-style): short utterances arriving
// one after another read as one flowing paragraph instead of a stack of
// one-line cards. Grouping is display-only -- the underlying lines (and
// their ids, used by the translation cache) are untouched.

interface GroupableLine {
  speakerKey: string;
  timestamp: number;
}

// A new paragraph starts when the speaker changes or after a natural pause.
// 45s matches how the pro transcription tools break paragraphs: long enough
// that deliberate, slow speech stays together, short enough that a real
// conversational turn later doesn't glue onto an old block.
const PARAGRAPH_GAP_MS = 45_000;

export function groupConsecutive<T>(
  items: T[],
  keyOf: (item: T) => GroupableLine,
  gapMs = PARAGRAPH_GAP_MS
): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const { speakerKey, timestamp } = keyOf(item);
    const current = groups[groups.length - 1];
    if (current) {
      const last = keyOf(current[current.length - 1]);
      if (last.speakerKey === speakerKey && timestamp - last.timestamp <= gapMs) {
        current.push(item);
        continue;
      }
    }
    groups.push([item]);
  }
  return groups;
}
