# Project memory log -- Taller-0 / Encuentro

Append-only. Newest entries at the bottom. See
`.claude/skills/memory/SKILL.md` for format and what belongs here.

## 2026-07-06 -- Stacked multi-speaker live captions
What: `LiveCaption` now renders one caption row per recent speaker (oldest on
top, newest at bottom), each expiring on its own timer, instead of a single
caption that flickered when 2-3 people talked at once.
Why: transcription itself was always correct (see decisions.md -- per-mic,
client-side), but the on-screen caption only ever showed the latest line, so
overlapping speech looked broken even though the transcript/history was fine.
Files: `client/src/components/LiveCaption.tsx`, `client/src/lib/captionLines.ts`.

## 2026-07-06 -- Raise hand
What: Added handRaised on Participant (client+server), a `raise-hand` socket
event, a ControlBar button, an amber tile badge, and sorting raised hands to
the top of ParticipantsPanel.
Files: `server/src/types.ts`, `server/src/socketHandlers.ts`,
`client/src/context/MeetingContext.tsx`, `client/src/components/ControlBar.tsx`,
`client/src/components/ParticipantTile.tsx`, `client/src/components/ParticipantsPanel.tsx`.

## 2026-07-06 -- Side-panel overlap fix
What: Fixed a side panel (Opciones/Chat/etc.) getting overlapped by video
tiles. Root cause was a flex-item default `min-width: auto` on `<main>`
keeping it from shrinking; fixed with `min-w-0` + `overflow-x-hidden`. Panels
are `shrink-0` flex columns on desktop, full-screen overlays on phones (was
getting squeezed to a sliver + clipped before).
Files: `client/src/pages/Meeting.tsx`, `client/src/components/SidePanel.tsx`.

## 2026-07-06 -- Dual side panels on desktop
What: Desktop can now open two panels at once (one docked left, one right --
e.g. IA + chat simultaneously); phones still show one at a time as a full
overlay. Reworked Meeting's panel state from a single `activePanel` to an
ordered `openPanels` list capped at 2 on desktop / 1 on mobile.
Files: `client/src/pages/Meeting.tsx`, `client/src/components/SidePanel.tsx`
and its wrappers (ChatPanel/TranscriptPanel/ParticipantsPanel/SettingsPanel)
which now accept a `side` prop.

## 2026-07-06 -- Faster connect + loading animation
What: Backend gets woken (health ping) on app load and again when a
join/create form mounts (`prewarm()` in MeetingContext), and the socket
pre-connects while the user is still typing -- covers Render's cold-start
delay. The "Conectando" screen shows three dots pulsing in sequence
(`LoadingDots`) instead of a static label.
Files: `client/src/context/MeetingContext.tsx`, `client/src/components/LoadingDots.tsx`,
`client/src/pages/Meeting.tsx`, `client/src/pages/{HostSetup,JoinForm,ExternalJoin}.tsx`.

## 2026-07-06 -- Accounts: login/register + private per-user history
What: Real accounts (email/password, scrypt hashing + HS256 JWT session
tokens, both on node:crypto -- no new deps). `users` table + `owner_id` on
`meetings`. History and meeting-AI endpoints require a Bearer token and are
scoped to the caller (`listMeetings`/`getMeetingDetail` filter by owner_id).
Guests can still create/join meetings without an account (see decisions.md);
only Historial is gated behind login (`RequireAuth`).
Why: user's core requirement was "que no todos puedan ver el historial" --
history needed to be private per account, not a shared list.
Verified end-to-end against a real local Postgres: register/login (incl.
case-insensitive email, duplicate -> 409, wrong password -> 401), a meeting
created via socket gets tagged with owner_id, and one user's history/detail
is invisible (empty list / 404) to another user.
Files: `server/src/auth.ts` (new), `server/src/db.ts`, `server/src/index.ts`,
`server/src/socketHandlers.ts`, `server/src/ai.ts`, `server/src/globalAi.ts`,
`client/src/context/AuthContext.tsx` (new), `client/src/lib/authToken.ts` (new),
`client/src/pages/{Login,Register}.tsx` (new), `client/src/components/{AccountMenu,RequireAuth}.tsx` (new).
Render setup needed: `AUTH_SECRET` env var (random secret, rotating it logs
everyone out by design); `DATABASE_URL` was already configured.
