---
name: memory
description: Persistent project memory across sessions -- inspired by claude-mem (thedotmack/claude-mem). Use at the start of a session to recall past decisions/context on Taller-0, and during/after meaningful work to record new observations so future sessions (which start with no memory of this conversation) don't have to rediscover them.
---

# Project Memory Skill

A lightweight, file-based alternative to claude-mem's full system (no Bun worker,
no SQLite, no vector DB -- just plain markdown files committed to the repo, so
they survive across ephemeral sessions/containers the same way any other
project file does).

Storage lives at `.claude/memory/` in this repo:

- `.claude/memory/log.md` -- append-only chronological log. Each entry is one
  dated, short block: what was decided/built/fixed and why, plus key file
  paths. This is the "observations" layer.
- `.claude/memory/decisions.md` -- durable architectural/product decisions
  that should NOT be re-litigated later without a good reason (e.g. "captions
  transcribe each participant's own mic client-side, not a shared stream").

## When to recall (read memory)

At the start of a session working on this repo, or before making a
non-trivial decision, skim `.claude/memory/decisions.md` in full (it's meant
to stay short) and grep `.claude/memory/log.md` for relevant keywords instead
of reading it end to end once it grows. Treat this the same way claude-mem's
`search` -> `timeline` -> `get_observations` pattern works: cheap filter
first, only pull full detail for what's actually relevant.

```bash
grep -n -i "<keyword>" .claude/memory/log.md
```

## When to record (write memory)

Append a new entry to `.claude/memory/log.md` when:

- A feature or fix is completed and the reasoning behind an approach isn't
  obvious from the diff alone.
- A bug's root cause was non-trivial to find (so it isn't rediscovered from
  scratch next time something similar happens).
- The user makes a product decision that will matter later (e.g. "guests can
  still create meetings without an account").

Do NOT log:

- Secrets, tokens, connection strings, API keys -- never, under any
  circumstances (this repo already treats Zoom/ACS credentials this way; the
  same rule applies to memory).
- Routine, self-evident changes with no decision behind them (e.g. a typo
  fix). Memory is for context that would otherwise be lost, not a changelog.

### Entry format

```markdown
## YYYY-MM-DD -- Short title
What: one or two sentences on what changed/was decided.
Why: the reasoning, especially anything non-obvious.
Files: key paths touched (repo-relative).
```

Keep entries terse -- a future session should be able to grep a keyword and
get the gist in a few lines, not read a essay.

## Durable decisions

`.claude/memory/decisions.md` is for things that should stick without
re-explaining every session: architecture choices, constraints the user has
stated more than once, security rules. Add to it sparingly -- most things
belong in `log.md` instead. Never remove an entry without confirming with the
user first, since these exist specifically to not be silently overridden.
