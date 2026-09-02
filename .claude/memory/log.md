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

## 2026-07-07 -- Unify rebrand + full redesign (blue, light/dark/auto themes)
What: complete visual system rebuild. tailwind.config colors all resolve to
CSS variables (index.css) with per-theme values; the ink scale is SEMANTIC
(950=page bg, 50=strongest text) and inverts between dark (navy #0F172A/
#1E293B/#334155) and light (#F8FAFC/white/#E2E8F0). brand = blue
(#38BDF8/#3B82F6/#1D4ED8); brand-100..300 flip per theme (accent text).
Two text intents: `text-strong` (flips) vs `text-on-accent` (always white,
for colored buttons/badges/caption bubbles) -- NEVER reintroduce raw
text-white for page text. ThemeProvider (unify_theme localStorage:
light|dark|auto) + inline pre-paint script in index.html; Apariencia radios
in AccountSettingsModal. Logo = two speech bubbles + U (sky + blue
gradient); slogan "Reuniones sin barreras" is the H1 and the <title>.
Inter via Google Fonts link. GoogleButton stays literal white (brand rule).
Verified both themes x both viewports on home/login/crear/externa/meeting +
live switch + persistence.
Files: client/tailwind.config.js, client/src/index.css,
client/src/context/ThemeContext.tsx (new),
client/src/components/{Logo,Button,IconButton,GradientBackdrop,
AccountSettingsModal,GoogleButton}.tsx, client/index.html, sweep across
all pages/components.

## 2026-07-07 -- Meet bridge + moderation system + single-presenter + 30-user scale
What: (1) extension/ = MV3 content script scraping Meet DOM (data-is-muted,
leave-button presence, people-badge count, roster only while Meet's panel is
open) -> POST /api/meet-bridge/:code (whitelist+clamp+rate-limit) -> relayed
to companion room `meeting:GOOGLE-MEET:<CODE>` -> MeetCompanionPane renders
with 30s freshness. Meet CANNOT be controlled remotely (no API) -- display
only, never authority. Selectors are best-effort; can't be E2E'd from the
sandbox (no network) -- bridge+UI verified with simulated posts.
(2) moderationRole host|cohost|participant on Participant; ONE "moderate"
socket event validates rank server-side (MODERATION_RANK + canModerate;
HOST_ONLY set for cohost-mgmt/transfer/end). Kick bans by normalized name
(guests have no durable identity -- documented weakness). Waiting room holds
join acks as {ok,waiting:true} -> "admitted"/"join-rejected" events. Chat
"hosts" mode delivers only to moderators+sender (toHostsOnly flag).
(3) meeting.presenterId enforces ONE share; presenter-changed broadcast;
auto-release on stop/leave/kick/policy; client toast via share-denied.
Meeting.tsx registers its own socket listeners for kicked/meeting-ended/
force-muted/moderation-request (media control lives there, not in context).
(4) cap native = 30; ParticipantTile memoized; lib/toasts.ts = module-level
store (fireable from socket handlers) + ToastViewport per page.
Tests (scratchpad): moderation_e2e.js 20/20, load_sim.js 5/10/20/30 (p95
<=6ms, 0 presenter violations), meet_and_mesh.js 11/11 (5x5 mesh ~6MB/tab),
route_sweep.js 12/12. Gotcha: index.html's Google Fonts link hangs
Playwright waitUntil:"load" in the sandbox -- always block **fonts.g** and
use domcontentloaded.
Files: extension/*, server/src/{types,meetingStore,socketHandlers,index}.ts,
client/src/{types.ts,context/MeetingContext.tsx,lib/toasts.ts,
components/{HostControlsPanel,MeetCompanionPane,ToastViewport,
ParticipantsPanel,ControlBar,ParticipantTile,VideoGrid,ChatPanel}.tsx,
pages/{Meeting,ExternalJoin,ExternalMeeting,Home}.tsx}.

## 2026-07-14 — Compartir pantalla en iPad: "¿cancelaste el permiso?"
- Causa real: `getDisplayMedia` NO existe en iOS/iPadOS (todo navegador ahí es WebKit); el catch genérico culpaba a un permiso cancelado.
- Fix: `client/src/lib/screenCapture.ts` — `screenCaptureSupported` (feature-detect) + `displayMediaErrorMessage()` (NotAllowedError = cancelación O bloqueo del SO en Mac; incluye la ruta de Ajustes). Hooks `useScreenShare`/`useRecorder` cortan temprano con mensaje honesto; botones Compartir/Grabar en ControlBar y ExternalMeeting muestran toast/label honesto.
- Verificado 11/11 con Playwright simulando API ausente, NotAllowedError y share normal (commit 3884bda).
- Regla: nunca un catch genérico sobre APIs de permisos — clasificar por `DOMException.name` y feature-detectar antes de llamar.

## 2026-07-21 — Carpetas, compartir carpetas, informes IA guardados, calendario Outlook
- **Carpetas**: tablas `folders`, `folder_shares`, `meetings.folder_id`. CRUD + mover, todo owner-scoped en SQL. `getMeetingDetailForUser`/`canAccessMeeting` dan acceso al dueño O a quien tenga la carpeta compartida (recipient recibe `sharedView:true` → UI read-only). Compartir por email de cuenta Unify existente.
- **Informes IA**: `meetings.report` + `report_generated_at`. `generateMeetingReport` (ai.ts) arma informe estructurado sobre toda la transcripción y lo persiste; se sirve instantáneo en aperturas siguientes; `?regenerate=1` fuerza uno nuevo. Reusa `buildMeetingSystemPrompt` compartido con Q&A.
- **Outlook/Microsoft**: `microsoftAuth.ts` (OAuth v2 + Graph calendarView), `users.ms_refresh_token`. Connect = fetch autenticado → redirect (token de sesión NO viaja en URL); state liga el userId. Rota refresh token. `CalendarPanel` (próximas reuniones + conectar) y `CalendarRecordWatcher` global (prompt "grabar en Ns" antes de reuniones con link). Degrada: oculto/deshabilitado sin `MS_CLIENT_ID/SECRET/REDIRECT_URI`.
- **Límite honesto auto-grabar**: el navegador exige un gesto para `getDisplayMedia`, así que el countdown lleva a la companion "lista para grabar" (deep link `/externa?link=...&rec=1`), no captura headless.
- Verificado con Postgres real: 25/25 API (CRUD, control de acceso a compartidas, restricciones de mover, read-back de informe, degradación de calendario) + 8/8 UI smoke (0 errores de consola). Commit a30253f.
- Postgres local para tests: corre como usuario `postgres` vía `runuser -u postgres -- $PGBIN/...` (initdb/postgres rechazan correr como root). Cliente de prueba: `VITE_SERVER_URL=... vite build --outDir dist-local` + `CLIENT_ORIGIN` debe incluir el puerto del preview o el CORS bloquea /api/auth/me y RequireAuth redirige a login.

## 2026-07-21 — Pantalla compartida (5+ cámaras + toggle) y grabación compuesta/auto
- VideoGrid presenter: todas las cámaras siguen visibles (flex-shrink, ≥5 entran antes de scrollear), toggle "Abajo"(filmstrip centrado)/"Al costado"(columna) persistido en localStorage.
- `useCompositeRecorder`: graba reuniones NATIVAS dibujando a canvas (todas las cámaras + pantalla compartida) + mezcla de audio de todos → captureStream + MediaRecorder. SIN getDisplayMedia ⇒ no requiere gesto ⇒ auto-grabar real; y nunca sale vacío. MP4 (H264/AAC) con fallback WebM. Sube por el flujo R2 existente ⇒ aparece en historial, reproduce, informe+IA intactos. Meeting.tsx pasa `sceneRef` (refrescado cada render con participants+streams).
- `RecordAutoPrompt`: aviso abajo-derecha al entrar, countdown 10s → auto-start + toast "empezó automáticamente"; "No" cancela. **Gotcha**: el countdown va en un ref (`onStartRef`), NO en deps del useEffect — Meeting re-renderiza cada segundo (pill de tiempo) y reiniciaba el interval, dejando el contador clavado en 10.
- Verificado en browsers reales: 5 personas → ≥5 celdas durante share y tras cambiar layout; MP4 1280x720 ~585KB 5.5s; auto-start tras countdown; recording-complete adjunta a historial; informe+IA disponibles. 17/17 E2E + 6/6 API. Commit 17c3d7c.

## 2026-07-21 — Simulación Meet + bug real de CORS del bridge
- **Bug de producción encontrado y arreglado**: el CORS estricto (solo CLIENT_ORIGIN) rechazaba el Origin `https://meet.google.com`, así que el POST del content script al bridge se bloqueaba en producción y el companion nunca recibía estado. Los tests previos no lo detectaron porque POSTeaban desde Node (sin header Origin). Fix: `corsDelegate` por-request — `/api/meet-bridge/*` acepta cualquier origen (payload ya whitelisteado/clampeado/rate-limited, solo display); el resto mantiene el allowlist estricto. Verificado: preflight+POST desde meet.google.com devuelven ACAO; /api/folders sigue rechazando meet.google.com.
- Simulación Meet 14/14 con **servidor http real** sirviendo el DOM falso de Meet (NO `route.fulfill`): detección de código, scraping (mic/cámara/count/roster), POST cross-origin real al bridge, companion muestra estado en vivo, **re-sync en vivo** al mutar el DOM (presentando, count 4→5, unmute, nuevo participante), botón "Grabar con Unify" + deep link.
- **Gotchas de test (no de producto)**: (1) `page.route("**/abc-defg-hij")` intercepta TAMBIÉN el POST del bridge (`:4001/api/meet-bridge/abc-defg-hij`, mismo sufijo) → fetch fulfilled con HTML falso, nunca llega al server. Usar URL exacta o servidor real. (2) `route.fulfill` de la navegación deja a la página un contexto donde el fetch cross-origin a otro puerto cuelga/falla → servir la página falsa desde un http.createServer real. Desde una página real el fetch browser→bridge anda perfecto ({ok:true,200}).
- Historial/carpetas/compartir 25/25; video guardado en historial 4/4 (recording-complete → recordingUrl en detalle y lista; IA disponible).

## 2026-07-24 — Grabaciones al historial + sync video↔transcripción
- **Grabación no llegaba al historial**: causa diagnosticada (el usuario salía antes de que terminara la subida). Fix: `handleLeave` difiere la salida con overlay "Guardando grabación…" hasta que el grabador deja de estar recording/processing/uploading (o 30s de respaldo); `dbIdRef` congela el id al iniciar; PUT directo a R2 reintenta 1 vez.
- **Respaldo de subida por servidor**: si el PUT directo browser→R2 falla (típico: CORS del bucket sin PUT del origen), el cliente reenvía el video a `POST /api/meetings/:id/recording-upload` (cuerpo crudo video/*, express.json() no lo toca), el server lo streamea a R2 con `@aws-sdk/lib-storage` Upload (partes de 5MB, sin bufferear todo en RAM) y lo adjunta. `uploadRecordingViaServer` en api.ts (fetch sin timeout). Verificado con S3 mock: simple <5MB y multipart 12MB byte a byte, 14/14.
- **Desfase video↔transcripción (varios segundos atrás + tirones)**: dos bugs de timestamp + render.
  1. Las líneas se guardaban con `created_at` = momento de INSERT (después del await de limpieza/traducción IA, varios seg) → offset inflado + posible desorden. Fix: `spokenAt = new Date()` capturado ARRIBA del handler `transcript-line` (antes de los awaits) y pasado a `recordMessage` como `created_at`.
  2. `recording_started_at = now()-duración` al completar la subida → le sumaba el retraso de subida. Fix: ping `POST /api/meetings/:id/recording-started` al arrancar (server fija `now()`); `attachRecording` usa COALESCE (respeta el ping, fallback a now()-duración sin ping). Ambos recorders (composite + external) pingean.
  3. `SyncedTranscript` reescrito: lee `video.currentTime` por rAF (play/pause/seeked/timeupdate), setState solo al cambiar línea/palabra, ítems memoizados. Antes cada timeupdate re-renderizaba toda la página+lista (tirones). Ahora recibe `videoRef` en vez de prop `currentTime`.
- Verificado con Postgres real + navegador: DB 7/7 (línea en tiempo hablado Δ=0ms vs 6s simulados; orden; ping ancla; fallback), navegador 12/12 (línea correcta a 1.5/4.5/7.5s, karaoke monótono 2→3→5→6→8, seek preciso), regresión menú ⋮+sync 10/10.
- **Residual honesto**: la línea se resalta cuando el reconocedor FINALIZA la frase (≈ al terminar de decirla), no cuando empieza — puede quedar ~1s de rezago vs el inicio del habla (antes eran varios seg). Si molesta, agregar un lead configurable / back-date por duración estimada.

## 2026-07-24 — Auditoría de producción (seguridad/robustez/responsive)
- Simulaciones REALES (Postgres local + navegador headless, sin mocks): carga 2/5/10/20/30 (27/27), seguridad REST (16/16), frontend/XSS/responsive (20/20). Scripts en scratchpad: sim_load_churn.js, sim_security_rest.js, sim_frontend.js.
- **WebRTC sin TURN**: SimplePeer usaba solo STUN por defecto → falla detrás de NAT simétrica/firewall. Nuevo client/src/lib/iceServers.ts (STUN público + TURN por env VITE_TURN_URLS/USERNAME/CREDENTIAL o VITE_ICE_SERVERS), pasado como config.iceServers en useWebRTC.
- **signal sin autorización**: reenviaba a cualquier socket. Ahora exige que emisor y destino estén en la MISMA reunión (aislamiento entre reuniones). Verificado.
- **Flood**: rate-limiters por socket en signal (1500/10s), estado presencia (media-state/raise-hand/screen-share/set-language/connection-quality, 60/10s compartido) y moderate (60/10s). raise-hand flood 400→60.
- **Fuerza bruta auth**: limiter por IP (trust proxy=1 para Render) en /api/auth/login|register|change-password → 429 tras 30/min.
- **Headers**: nosniff, X-Frame-Options DENY, Referrer-Policy no-referrer, HSTS; x-powered-by off. (API JSON, sin CSP; el HTML está en Vercel.)
- **Memory leak**: historicalParticipants crecía sin límite con churn → acotado a 250 (desaloja primero a los desconectados) en meetingStore.addParticipant.
- **Responsive**: historial/detalle desbordaban ~12px a 320px (header) → px-4 sm:px-6 + grupo de header encogible.
- SQLi: queries 100% parametrizadas (grep confirmó, y login con payload no autentica). XSS: React escapa + no hay dangerouslySetInnerHTML + react-markdown no renderiza HTML crudo → payload almacenado se muestra escapado, no ejecuta.
- **Límite arquitectónico honesto**: topología MALLA (mesh). Con video escala ~10-15; tope duro 30 (MAX_PARTICIPANTS_NATIVE). 50 con video requiere un SFU (servidor de medios) = infra aparte, no cambio de código. Documentado al usuario, NO afirmado como soportado.

## 2026-07-24 — Verificación reuniones externas (companion) + fix acceso IA
- Simulaciones reales (Postgres + navegador): sim_companion.js (15/15) y sim_external_ui.js (15/15) en scratchpad.
- Substrato companion OK: detección de enlaces (meetingPlatforms.detectMeetingPlatform), ruteo a embed (Jitsi/Zoom/Teams/MeetCompanionPane), sala compartida por externalKey (getOrCreateCompanionMeeting uppercasea la key), sync transcript/chat, aislamiento entre keys, reconexión por key, persistencia (createMeetingRecord), y errores claros sin pantalla en blanco cuando falta ZOOM_SDK_KEY/ACS (503 → mensaje). Embeds bien construidos (watchdog+retry en Zoom, fallback companion en Teams personal, JitsiEmbed limpio).
- **Bug corregido**: en salas companion (y cualquier reunión multi-participante) sólo el DUEÑO podía usar la IA / ver la transcripción; al resto → 404 aunque se les mostraba el panel. Fix: `Meeting.authedUsers` (socketId→userId, fuera del snapshot); `isLiveParticipant(dbId,userId)`; addParticipant recibe userId (create/join-meeting/join-companion, del token — join-meeting nativo del cliente ahora manda token); `getMeetingDetailRaw(id)` (sin filtro de dueño); GET /api/meetings/:id y /ask permiten a un participante EN VIVO (además del dueño); answerFromMeeting acepta liveParticipant. Acceso solo mientras está en la sala (al salir → 404); extraño → 404 siempre.
- Limitaciones honestas (no bugs): la IA necesita cuenta (un invitado sin login no puede usarla); Zoom SDK puede requerir headers COOP/COEP (cross-origin isolation) en Vercel para rendimiento pleno; Teams sólo work/school (personal cae a companion mode); Meet necesita la extensión para el estado en vivo (sin ella, subtítulos/IA igual andan por el micrófono).

## 2026-07-24 — UX de código/campos + honestidad de plataformas externas
- **Mayúscula automática**: agregados presets de teclado móvil en lib/ui.ts (nameInputProps=words, sentenceInputProps=sentences, codeInputProps=characters, urlInputProps/emailInputProps=none) aplicados en unirse/crear/externa/login/registro/chat/IA/roles/compartir/ajustes. Emails y enlaces NO se autocapitalizan (una mayúscula rompía URLs/emails).
- **Código de reunión más fácil**: normalizeMeetingCode(raw) acepta link pegado (…/unirse/CODE), saca espacios/guiones y pone MAYÚSCULAS. El server ya era case-insensitive (getMeeting uppercasea). Campo con autocapitalize=characters + autocorrect off. Verificado 12/12 (normalización + unirse con código en minúscula E2E).
- **Honestidad de plataformas**: GET /api/platforms {zoom,teams,jitsi,google-meet}. ExternalJoin consulta y, si Zoom/Teams no tiene credenciales en el server, avisa ("faltan credenciales de X") y ofrece "Abrir en X" en vez de un botón de unirse que daría error. Jitsi/Meet siempre disponibles. Ante server lento se asume disponible. Verificado 7/7.
- **Credenciales**: siguen siendo secretos que el usuario carga en Render (ZOOM_SDK_KEY/SECRET, ACS_CONNECTION_STRING). NO se pegan en el chat. Jitsi no necesita nada; Meet corre como companion.

## 2026-07-24 — BUG raíz reuniones externas: COOP/COEP en vercel.json rompía Jitsi
- El usuario aclaró que las credenciales de Zoom/Teams YA están en Render. Auditando el código de integración (zoom.ts firma SDK v5 OK, teams.ts createUserAndToken voip OK, endpoints OK), el bug real estaba en client/vercel.json: mandaba COOP:same-origin + COEP:credentialless (para SharedArrayBuffer de Zoom), pero COEP BLOQUEA los iframes cross-origin sin COEP → Jitsi (iframe a meet.jit.si) quedaba en blanco.
- Contradecía la intención del propio código: types/zoom.d.ts comenta que patchJsMedia se usa para "saltear COOP/COEP que romperían el iframe cross-origin de Jitsi". Zoom SDK 6.2.0 + patchJsMedia:true (ya activo) anda sin aislamiento.
- Fix: quitados COOP/COEP de vercel.json; agregados headers seguros (nosniff, Referrer-Policy, X-Frame-Options SAMEORIGIN). Zoom sigue por fallback; Jitsi/Teams dejan de bloquearse.
- Verificado el MECANISMO en navegador (/tmp/coep_test.js): CON COEP el iframe cross-origin se bloquea (childText vacío, crossOriginIsolated=true); SIN COEP carga. 3/3. Efecto final requiere deploy en Vercel + probar Zoom+Jitsi reales.

## 2026-07-24 — Correcciones urgentes reuniones externas + auditoría foolproof
- **3 correcciones urgentes (commit 7d982eb)**:
  1. CRÍTICO: ExternalMeeting.handleLeave abandonaba la subida de la grabación (Meeting.tsx ya lo esperaba, la externa no). Fix: `exitWhenSaved(exit)` + `pendingExitRef` + `savingRecording` + overlay + respaldo 30s. Cubre los 3 caminos (salir, guardar en cuenta, saltear). Verificado forzando la subida a colgarse con page.route: overlay aparece, NO navega, y al liberar recién sale. 6/6.
  2. CRÍTICO: Login/Register hacían `void claimMeeting().then(clearUnsavedMeeting)` → borraban el puntero AUNQUE el reclamo fallara y navegaban antes de terminar. En sala externa con dueño previo el invitado veía "listo" y no estaba. Fix: await + solo limpiar si `claimed` + navegar con `state.claimFailed` → History muestra aviso honesto. 7/7.
  3. MEDIO: Jitsi con acentos → roomName llegaba percent-encoded y abría OTRA sala. Fix: safeDecode en el parser. "reunión-año" y "reuni%C3%B3n-a%C3%B1o" convergen.
- **Extracción de URL (commit 07d2e47)**: pegar la invitación con texto alrededor ("Unite a mi llamada https://…", mensaje de WhatsApp multilínea, <>, «») daba "no reconocimos". Fix en `normalizeUrl`: extrae el primer http(s) del texto; si no hay, limpia símbolos. + endurecimiento: solo http/https (rechaza javascript:, data:, javascript://…). 11/11.
- **Gotcha de test**: en Playwright los patrones de route se solapan — `**/recording-upload*` capturaba también `recording-upload-url`. Usar regex (`/\/recording-upload-url$/` y `/\/recording-upload\?/`).
- **Tests desactualizados**: sim_external_ui asumía que Zoom ofrecía "Unirme acá dentro"; con el gating de /api/platforms (zoom:false en sandbox) ya no. Actualizado a validar coherencia (o unirse+pass, o aviso+abrir afuera).
- **Auditoría foolproof entregada** (artifact): casos raros con auto-resolución (espejo infinito, grabación sin audio, permisos, companion), mecanismos internos, guion de micro-copia, invitados, y 5 riesgos futuros (cambios de SDK externos, costo de IA, legal de grabación, estado en memoria de un solo servidor, salas externas adivinables).
- **Hallazgos NO implementados (propuestas)**: detección de self-share (`displaySurface` + `selfBrowserSurface:"exclude"`), verificación de audio a los 5s de grabar, guía de un clic para desbloquear micrófono, cola local de transcripción durante cortes, reclamo de múltiples reuniones, registro de plataformas no soportadas (Webex/GoTo/Whereby).

## 2026-08-07 — Extensión de Meet v2 (transcribe y graba a TODOS, dentro de Meet)
- **Causa raíz "solo grabó mi voz"**: la transcripción usaba Web Speech API = solo el micrófono propio. Imposible capturar a otros así. **Fix**: leer los subtítulos NATIVOS de Google Meet (traen a todos + nombre). La extensión los activa sola si están apagados.
- **Grabación**: se pasó de getDisplayMedia (elegir pestaña + tildar audio, salía muda) a `chrome.tabCapture.getMediaStreamId` + documento **offscreen** (MV3 no permite MediaRecorder en el service worker). Mezcla audio de pestaña (todas las voces) + micrófono propio con pre-gain 0.85 y limitador; **devuelve el audio a los parlantes** (capturar una pestaña la silencia). Sube por `POST /api/meetings/:id/recording-upload?durationMs=` (sin CORS por host_permissions).
- **Panel dentro de Meet** (no más pantalla dividida): `#unify-panel` inyectado, arrastrable/plegable, 3 pestañas (Transcripción/Subtítulos/IA) + botón grabar + overlay `#unify-subs` sobre el video.
- **Motor de subtítulos — 2 bugs reales encontrados por el test y corregidos**:
  1. Duplicados: el observer re-procesaba filas ya emitidas. Fix: el registro NO se borra mientras el nodo siga en el DOM; se guarda `emitted` y solo se manda el delta.
  2. Nombre mal separado al inicio de la frase: la heurística "el bloque más largo es el texto" falla cuando el texto recién arranca ("buenos" < "Ana García"). Fix: estructural — hojas con texto, `leaves[0]` es el nombre si `looksLikeName()` (≤60 chars, ≤6 palabras, sin puntuación final).
- **Bug de orden real**: se leía `chrome.storage` ANTES de definir `const ui` → si el navegador responde sincrónicamente, ReferenceError (TDZ) y la extensión no arrancaba. Fix: `loadConfig()` invocado al final.
- **Server**: `addNamedTranscriptLine` (speakerId `caption:<nombre>`) + endpoints `POST /api/meet-bridge/:code/transcript`, `GET .../session`, `POST .../ask` (requireAuth; el código del Meet es el alcance). `companionForMeet()` crea el registro si hace falta.
- **Sesión sin copiar tokens**: content script `auth-sync.js` en los orígenes de la web de Unify lee `localStorage.encuentro_token` → `chrome.storage.local`. Evita el problema del ID de extensión desconocido (mejor que externally_connectable).
- **Unión más fácil**: detección al pegar (sin botón) + `extractPasscode()` saca la clave del texto pegado.
- Verificado 61/61 (captions 14/14 contra Meet simulado que reescribe filas en vivo, bridge 10/10, companion 15/15, UI externa 15/15, fixes 7/7). **tabCapture no se puede ejecutar en el sandbox** — construido y revisado, requiere navegador con la extensión instalada.

## 2026-08-07 — Subtítulos visibles en companion + extensión probada DE VERDAD
- **Contexto real del usuario**: iPad + Safari, entra al Meet DESDE Unify (companion). No hay extensiones en iPadOS → la única forma de sumar voces ajenas es que cada participante abra Unify (cada navegador solo oye su propio micrófono).
- **3 causas de "no andan los subtítulos ni la traducción"**:
  1. `useLineTranslations` descartaba el error de traducción con `.catch(()=>{})` → fallo SILENCIOSO. Ahora expone `translationFailed` y la UI lo explica. (Sin ANTHROPIC_API_KEY el server devuelve 502; el respaldo MyMemory está bloqueado por el proxy del sandbox.)
  2. No había DÓNDE ver los subtítulos: `LiveCaption` es un overlay de 6s sobre el pane, inútil cuando mirás Meet en otra app. Nuevo `CompanionSubtitleStage`: texto grande, últimas 8 frases persistentes, traducción como lectura principal + original debajo, rol del hablante. `MeetCompanionPane` pasó a cabecera compacta + escenario.
  3. El selector de idioma estaba enterrado en el panel de transcripción → con "automático" hablando español no hay nada que traducir y parecía roto. Movido a `CompanionDock` (arriba a la derecha).
- **Extensión v3** (Shadow DOM, badge, drawer 3 pestañas, subs flotantes, roles, mic fallback, atajo Ctrl+Shift+U para grabar porque Chrome exige invocación desde la barra para tabCapture).
- **PRUEBA REAL DE LA EXTENSIÓN** (nuevo, antes imposible): `sim_realext.js` copia la extensión a un temp dir, le agrega `http://localhost:4189/*` al manifest (el manifest publicado NO se toca), y la carga con `launchPersistentContext({headless:false, --load-extension})` bajo `xvfb-run`. Verifica service worker MV3 activo, Shadow DOM, badge, 3 pestañas, y transcripción de 3 hablantes. **11/11**.
  - **Gotcha clave**: el content script corre en mundo AISLADO → pisar `window.fetch` de la página NO lo intercepta. Hay que usar `ctx.route()` a nivel navegador.
- Roles en companion: `lib/companionRoles.ts` (locales por reunión en localStorage; una sala companion no tiene anfitrión que los reparta), badges en LiveCaption + stage + panel `CompanionRolesPanel`.
- `CompanionDock`: estado, idioma, contador y —lo más útil— invitación en un toque (navigator.share o portapapeles) porque sumar gente a Unify es la ÚNICA forma de tener sus voces en iPad.

## 2026-09-02 — Verificación completa: 36/36 suites, y el puente de traducción
- **Parpadeo de idioma en subtítulos (externas e internas)**: cada fusión de fragmentos (misma id, texto que crece) o corrección de la IA re-pedía la traducción y, en el hueco, todas las pantallas volvían al idioma original. Fix: la última traducción resuelta hace de PUENTE hasta que llega la nueva — `useLineTranslations.getTranslation` (web: stage, LiveCaption, PiP doc, canvas PiP, panel), `traducciones` con `pedida`/puente en `prompt-injector.js`, y en `content.js` la corrección ya no borra `line.translated` + guarda `textoPedido` contra respuestas tardías. Probado con guion en `sim_realext` (ruta `/api/translate` con demora por contenido + `respuestaIA` async).
- **Autoscroll del stage**: dependía de `lines.length`; una línea fusionada o su traducción no movían el scroll. Ahora clave de contenido, scroll directo (no smooth) y botón «Volver a lo último» si la persona subió a releer.
- **Carrera del historial (server + socket)**: el insert de la línea es fire-and-forget; si un fragmento se fusionaba antes de resolver, la fila quedaba con el primer pedazo. Fix: al resolver, si `line.text` creció, `updateMessageText`.
- **Suites frágiles**: `sim_malla`/`sim_errores` recorrían `getByRole("button").all()` y clicaban por índice; un botón transitorio corría los índices → timeout 30 s. Clicar por rol+nombre accesible (`/No, gracias/`).
- **Rituales del sandbox**: el contenedor RETROCEDE el repo (a 566c154) y borra scratchpad/desktop node_modules → `git fetch` + `reset --hard origin/<rama>`, `npm install` en desktop, Postgres `pg_ctl -D /tmp/pgdata -o '-p 5433'`, servidor con `reiniciar-servidor.sh`. Batería completa = 35 suites con `xvfb-run -a` + `sim_agenda.ts` (tsx + DATABASE_URL); cola disruptiva al final (`basecaida`, luego `renacer` y `carga` con 4001 LIBRE) y `sim_video_ia` aparte (también 4001 libre). `sim_movil` puede tardar 8+ min por fuentes de Google vía proxy. Producción (Render/Vercel) está BLOQUEADA por el proxy del sandbox (403 CONNECT): se verifica por el workflow «Mantener el servidor despierto» en GitHub.
- Extensión 4.10.2 empaquetada (la tienda tiene 4.10.0).

## 2026-09-02 — Subtítulos al instante, anti-eco, contexto e idioma en un toque
- **Emisión inmediata (socket + bridge)**: la lectura cruda sale marcada `provisional: true` y el parche de la IA llega sobre la misma id (`provisional: false`). Sólo cuando `anthropicEnabled` (sin IA no hay nada que esperar: una sola emisión, y las suites sin clave no cambian). En el bridge el fragmento crudo se reemplaza DENTRO de la línea (puede haber crecido por otra fusión) y `limpiezasPendientes` cuenta cuántos fragmentos de la línea siguen esperando corrección. En el socket, si la línea cambió mientras la IA pensaba, ese parche se descarta (la limpieza del fragmento nuevo abarca la línea entera). Web y overlay NO traducen líneas provisionales.
- **Anti-eco (`server/src/eco.ts`)**: `buscarEco(meeting, speakerId, fragmento)` mira las últimas 12 líneas de OTRO hablante dentro de 8 s (`actualizadoEn ?? timestamp`); eco = Dice sobre bigramas ≥ 0,8, o el fragmento contenido, mínimo 4 palabras. Política: el eco se descarta (bridge responde `{ok, eco:true}`); si la línea original era de un oído genérico («La reunión», «Voces de la reunión», «Pantalla de…») y el eco trae nombre, se RENOMBRA la línea (misma id, re-emisión) y la fila del historial (`updateMessageSender`, `dbIdPorLinea`).
- **Traducción web con contexto**: `translate(text, source, target, context)`; `useLineTranslations` pasa las 3 líneas previas y la clave de caché es `${id}:${lang}:${huella(texto)}` (largo + djb2), no sólo el largo.
- **Idioma en un toque en la reunión interna** (`Meeting.tsx`): dos frases propias seguidas con `sourceLang` distinto → banner ámbar + «Escuchar en X» → `setSelfLanguage(codigoCompletoDe(corto))`. `etiquetaDeIdioma` ahora entiende códigos cortos.
- Pruebas: sim_bridge +8 (eco por bridge, por socket, renombre, frases cortas libres, historial), sim_traduccion +2 (provisional → parche) y la fusión se cuenta por ids distintas (cada fragmento ahora emite dos veces con la IA prendida). Extensión 4.10.3.
