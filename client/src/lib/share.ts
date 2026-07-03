// Zoom-style direct-join link: takes whoever opens it straight to a
// name+language form for this specific meeting, skipping the manual
// code-entry step entirely (see the optional :code param on /unirse).
export function meetingJoinUrl(code: string): string {
  return `${window.location.origin}/unirse/${code}`;
}
