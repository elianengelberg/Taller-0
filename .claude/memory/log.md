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

## 2026-07-07 -- Account dropdown replaces bare "Salir" button
What: The header's standalone "Salir" (logout) button was removed -- users
read it as "go back" and it silently logged them out. "Hola, <nombre>" is now
a dropdown trigger (avatar + chevron pill) revealing Configuración and Cerrar
sesión; settings live in a centered modal (rename + change password, new
PATCH /api/auth/me and POST /api/auth/change-password endpoints).
Why: real user confusion in production ("toque salir para volver al menu y me
cerro sesion"). Destructive-ish actions should need a deliberate second click.
Files: `client/src/components/{AccountMenu,AccountSettingsModal}.tsx`,
`server/src/index.ts`, `server/src/db.ts`.

## 2026-07-07 -- Google Sign-In (plain OAuth2, no SDK)
What: Google login via 2 raw fetches (token exchange + userinfo), mirroring
how zoom.ts/teams.ts avoid heavy client libs. `googleAuthEnabled` gates
everything on GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI env vars; the client asks
GET /api/auth/config whether to even show the button. Account merging: same
email with an existing password account gets google_id linked (not a dup);
brand-new Google users get password_hash NULL rows, and password login for
those returns "Esa cuenta se creó con Google". Callback redirects to
CLIENT_ORIGIN/auth/google?token=..., a tiny page that stores the token and
hard-reloads "/".
Why: server-side flow (not Google's JS widget) keeps the client dependency-
free and the secret server-only. In-memory single-use `state` map (10-min
TTL) because the app has no cookie middleware for a session-based check.
Production setup (user-owned, never in chat): Google Cloud OAuth client;
JS origin = https://taller-0.vercel.app, redirect URI =
https://taller-0.onrender.com/api/auth/google/callback; consent screen
published (En producción, 100-user unverified cap is fine for now).
Files: `server/src/googleAuth.ts` (new), `server/src/{index,db}.ts`,
`client/src/pages/GoogleCallback.tsx` (new),
`client/src/components/GoogleButton.tsx` (new), `client/src/lib/api.ts`.

## 2026-07-07 -- CORS: normalize origins + log rejections (prod outage postmortem)
What: corsOrigin() now normalizes both the env value and the incoming Origin
(trim, strip quotes, strip trailing slash, lowercase) before comparing, logs
the allowed origin at boot and every rejection with expected-vs-received.
Socket.io uses the same function.
Why: PRODUCTION BUG. After the user edited Render env vars, every browser
fetch from the Vercel app got CORS-rejected while top-level redirects (which
skip CORS) kept working -- so Google login "succeeded" (token visible in the
URL) but the session never stuck, the Google button "disappeared" (the
/api/auth/config fetch failed too), and register broke. The exact-string
compare made a single hand-typed character difference in CLIENT_ORIGIN break
everything silently. Diagnosis key: redirects working + fetches failing =
CORS, and the absence of `[google-auth] callback error` in Render logs proved
the server side was fine.
Files: `server/src/index.ts`.

## 2026-07-07 -- Never clear the auth token on network failure
What: authMe() now distinguishes 401 (unauthorized: true -> clear token) from
network/CORS/cold-start failures (keep token, just render logged-out for this
load). AuthContext only deletes the stored token on the explicit 401.
Why: the old code treated ANY authMe failure as an invalid session and wiped
localStorage -- on a free-tier Render backend that cold-starts for 50s+, a
single transient failure permanently logged people out. This compounded the
CORS bug above into "Google login doesn't work".
Files: `client/src/lib/api.ts`, `client/src/context/AuthContext.tsx`.

## 2026-07-07 -- Meeting toolbar: Zoom/Teams hybrid redesign
What: ControlBar groups controls into 3 clusters (personal AV | meeting
features | host tools) separated by thin vertical rules (hidden on mobile
where the grid wraps); "Salir" is a wide labeled red pill apart from the icon
row; header gains an elapsed-time pill (useElapsedTime, counts from
connected, hidden on mobile).
Why: user sent Zoom Workplace + Teams screenshots asking to combine the best
of both. Teams' grouped toolbar + prominent leave; Zoom's icon+caption style
was already in place. Kept the app's own warm dark palette, not their brands.
Files: `client/src/components/ControlBar.tsx`, `client/src/pages/Meeting.tsx`,
`client/src/components/icons.tsx` (ClockIcon).

## 2026-07-07 -- Full QA sweep methodology + mobile header overflow fix
What: QA = run the real server locally (npx tsx src/index.ts with
CLIENT_ORIGIN=http://localhost:4173, no DATABASE_URL -> graceful 503s) + vite
preview of the prod build + one Playwright script over every route at
1280x800 and 390x780 collecting console errors, pageerrors, final URLs
(redirect guards) and `scrollWidth - clientWidth` per page (horizontal
overflow). Meeting flow tested for real with
--use-fake-ui-for-media-stream/--use-fake-device-for-media-stream.
Found: logged-out mobile header overflowed 57px (Logo + Historial + Ingresar
+ Crear cuenta > 390px) -> "Crear cuenta" now hidden below sm (the banner
under the header repeats both auth actions). Also scanned dist/assets for
secret patterns (sk-ant, AKIA, GOCSPX, postgres://, PRIVATE KEY) -- clean.
Why: the overflow check catches a class of mobile bug screenshots alone
missed for weeks; the element-level culprit finder (getBoundingClientRect
right > viewport) pinpoints the offender instantly.
Files: `client/src/components/AccountMenu.tsx`.

## 2026-07-07 -- Full production-readiness audit (fixes + verified clean areas)
What: whole-codebase audit (10.9k lines). Fixed: (1) useWebRTC one-way-media
race -- peers created before getUserMedia resolved never got the local
stream; now tracked in streamlessPeersRef and attached retroactively.
(2) recording-complete accepted arbitrary URLs stored+rendered in the
owner's history (video src / download href) -- now validated against the R2
public base (storage.isOwnRecordingUrl). (3) Open Claude-billed endpoints
(/api/translate, /api/explain-error) got input caps; socket transcript
alternatives capped 5x600 chars; roles capped 50/meeting; externalKey capped
512; generous per-socket rate limits (30 transcript / 20 chat per 10s).
(4) Google token moved to URL fragment (out of request logs). (5) Bounded
translate/cleanup caches + pruned OAuth state map (all grew unbounded).
(6) JSON error middleware; presign try/catch (used to hang the request).
Verified clean: History/MeetingDetail already .catch() network errors;
LiveCaption timers, useSpeechRecognition restart backoff, meetingStore
cleanup grace, host-reclaim, transcript merge race checks all sound.
Two-participant WebRTC meeting verified end-to-end with Playwright (both
sides 2 tiles playing, 0 console errors).
Known accepted risks (documented, not changed): db.ts ssl
rejectUnauthorized:false (needs proper CA someday); login reveals "esa
cuenta se creó con Google" (deliberate UX tradeoff); mesh topology caps
practical meeting size (~6-8 people).
Files: client/src/hooks/{useWebRTC,useLineTranslations,useRecorder}.ts,
client/src/pages/GoogleCallback.tsx, server/src/{index,socketHandlers,
storage,db,googleAuth,translate,transcriptCleanup,ai,globalAi}.ts.
