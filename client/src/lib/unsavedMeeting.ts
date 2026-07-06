// Fallback for a guest (no account) who skips the post-call "save this
// meeting?" prompt: remembers the last such meeting's id in this browser so
// it isn't lost to any mishap (closed tab, etc.) -- a login/register later
// can still claim it from here. Cleared once claimed or replaced by a newer one.
const KEY = "encuentro_unsaved_meeting";

export interface UnsavedMeeting {
  dbId: string;
  joinCode: string;
  endedAt: number;
}

export function setUnsavedMeeting(m: UnsavedMeeting): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* private mode / storage disabled -- nothing to fall back to, same as before */
  }
}

export function getUnsavedMeeting(): UnsavedMeeting | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearUnsavedMeeting(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
