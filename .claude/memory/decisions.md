# Durable decisions -- Taller-0 / Encuentro

Things that should stick without re-litigating each session. See
`.claude/skills/memory/SKILL.md` for how this file is used.

- **Secrets never in chat.** Zoom Client Secret, ACS connection string, and
  any future third-party credential are configured only in Render env vars
  (`ZOOM_SDK_SECRET`, `ACS_CONNECTION_STRING`, etc.) -- never pasted into the
  conversation, never logged, never committed.
- **Model identity never in commits/PRs.** The model identifier must not
  appear in commit messages, PR titles/bodies, or code comments -- chat
  replies only.
- **Guests can create/join meetings without an account.** Login is required
  only to view Historial (private per-account meeting history). Don't gate
  meeting creation/join behind auth without the user asking for that
  explicitly.
- **Transcription is per-participant, client-side.** Each participant's
  browser transcribes only their OWN microphone (Web Speech API) and sends
  finalized lines to the server independently -- there is no shared/mixed
  audio stream. This is why overlapping speech from several people doesn't
  garble the transcript.
- **Translation quality lives server-side, per-language.** `server/src/translate.ts`
  has per-language linguistic-expertise hints (homophones, accent rules,
  script pinning for Chinese, compound words for German, etc.) plus a
  domain-vocabulary hint per language. Presentation-layer subtitle
  improvements (stacking, showing original text) apply uniformly across all
  languages without needing per-language UI work.
- **Companion (external-meeting) architecture.** Encuentro's subtitle/AI
  layer rides on top of embedded external meetings (Zoom/Teams/Jitsi) by
  transcribing the user's own mic and syncing over Socket.io, keyed on a
  deterministic external-room key (`zoom:<num>`, `teams:<threadId>`,
  `jitsi:<room>`). It reuses the native meeting's socket handlers unchanged.
- **Teams personal meetings aren't embeddable.** Azure Communication Services
  interop only works for Teams Work/School meetings, not "Teams for life"
  (personal). Personal Teams falls back to a companion-mode button (open in a
  new tab + keep the Encuentro overlay).
- **Third-party secrets NEVER go through chat.** Zoom SDK secret, ACS
  connection string, Google OAuth Client Secret, Anthropic key: the user
  creates them in the provider's console and pastes them directly into
  Render env vars. The Client ID is public and fine to share; the secret is
  not. Code must degrade gracefully (feature hidden/503) when unset.
- **CORS origins are compared normalized, never as raw strings.**
  `normalizeOrigin()` in server/src/index.ts (trim/quotes/trailing-slash/
  lowercase) + rejection logging. A hand-typed env var broke production once;
  don't reintroduce exact-string origin comparison.
- **A stored session token is only deleted on an explicit 401.** Network
  failures, CORS failures and free-tier cold starts must never log the user
  out permanently (client/src/lib/api.ts authMe contract).
- **Logout must never be a single bare click in the header.** It lives inside
  the account dropdown ("Hola, X" -> Cerrar sesión) because a visible "Salir"
  button gets read as "go back".
- **Production endpoints:** frontend https://taller-0.vercel.app (Vercel,
  auto-deploys this branch), backend https://taller-0.onrender.com (Render
  Web Service "Taller-0", free tier, ~50s cold starts). Google OAuth redirect
  URI is pinned to the onrender callback; changing domains means updating
  Google Cloud + Render env vars together.
