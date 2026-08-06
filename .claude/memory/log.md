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
