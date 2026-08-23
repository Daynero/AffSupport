# Quickstart — validating the Team Mode UX Refresh

Validation guide only; implementation detail lives in `tasks.md` and the contracts.

## Prerequisites

- Node 22, repo installed (`npm install`).
- Local beta stack for manual walkthroughs: see `docs/BETA.md` (`node scripts/beta-up.mjs`).
  **Team mode is allowlist-gated**: the signed-in beta user must have an `admin_users` row or
  belong to an allowlisted team, otherwise `/team` shows only the waitlist gate
  (`docs/BETA.md`, "team workspace access gate"). Drive-dependent flows need the opt-in OAuth
  test client from the same doc; everything else (navigation, invitations, tasks, dialogs,
  glossary) validates without Drive.
- Weak-machine etiquette: run targeted test files, not the whole suite, while iterating
  (`npx vitest run tests/team-ux-navigation.test.tsx`); don't run the beta stack and the full
  suite simultaneously; the full `npm test` is a pre-PR gate, not an inner loop.

## Automated gates (must pass before PR)

```bash
npm run format:check
npm run lint
npm test                          # builds shared, runs vitest incl. the new team-ux-* suites
npm run build -w @video-compressor/web   # type gate (no tsc --noEmit script exists)
npm run test:db                   # PGlite — includes the new SQL-function tests
```

After the migration lands: `npm run types:supabase` regenerated types are committed, and
`scripts/generate-team-contract-sql.mjs` output is refreshed for the PGlite harness.

## Per-story manual validation (beta stack)

**US1 — Orientation** (`tests/team-ux-navigation.test.tsx` covers the DOM half)
1. Enter `/team` with two spaces → lobby; enter a space → URL becomes `/team/<id>`.
2. Walk Files → Tasks → Settings; press browser Back twice → Tasks, then Files. Refresh on
   any section → same space, same section.
3. Paste a section link in a second browser signed in as a non-member → neutral no-access
   screen (no space name).
4. With exactly one ready space and no invitations → `/team` lands directly in it; the space
   name in the header opens the switcher back to the lobby.
5. Wizard: step 2 has Back; the name survives the round trip.

**US2 — Files** — in a space whose root has only subfolders: search и filters are present.
Rename and move a file from its row (picker, not an ID field) in ≤3 actions; load search
results past 50; have a second account add a file — the list updates without refresh; press
`/` — search focuses.

**US3 — Feedback** — kill network mid-action: every action yields a toast (human copy, no
codes). Provenance failure shows an error toast. Disconnect realtime (dev tools, offline) →
header chip appears, sync banner keeps updating via the poll fallback; a failed scan shows
the retry banner. Remove the test user from another session → sticky explanation + lobby.

**US4 — Lifecycle** — invite user B; B sees the invitation in the lobby (and a badge on the
Home card), accepts, lands in the space; B leaves the space (confirm) and loses access.
Owner abandons a wizard, then deletes the draft from the lobby. A viewer-only member of a
detached space sees the explanatory state in Files.

**US5 — Reversibility** — trash a file → Undo in the toast restores it; trash again → find
and restore it in `/team/<id>/trash`. "Create task" from a card → cancel → no task exists
anywhere; create → delete it (confirm). Detach drive → confirm names the consequence; detach
a task attachment → no dialog, Undo re-attaches.

**US6 — Consistency** — every dialog closes on Escape; background never scrolls; preview
cannot appear under another dialog. `npx vitest run tests/team-i18n-glossary.test.ts` — the
glossary test is the copy audit (no «Таски», no placeholder gate title, Close vs Cancel).
Task list empty state offers "create first task"; a loading list never claims "no matches".

**US7 — Background batch** (needs a paired local agent) — start a library batch, close the
dialog: header chip keeps counting; reopen from the chip; on completion a summary toast
appears; partial failure lists the failed items. Cancel is explicit and confirmed.

**SC-009 spot-check** — on the weak reference machine, in a 50-item search page: open a row
menu, toggle selection, switch sections — each response ≤200 ms by feel/profiler; no long
main-thread stalls from mounting row actions.

## Release note

This ships as a web + Supabase change: verify with `npm run verify-release -- --deploy`
preconditions that no unreleased `apps/agent` / `packages/shared` deltas ride the web deploy
(constitution II). Migration is forward-only with reverse steps documented in `ROLLBACK.md`.
