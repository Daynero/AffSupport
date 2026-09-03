---
description: 'Task list for the 2FA Notebook'
---

# Tasks: 2FA Notebook

**Input**: Design documents from `/specs/016-totp-notebook/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included. Not because the spec asked for TDD, but because the
constitution makes them a gate — `npm run lint` and `npm test` must pass before
a PR, all tests live in the central `tests/` directory as `*.test.ts(x)`, and
this feature's test files are named in the plan and exercised by the quickstart.
Each test task precedes the implementation it covers and is expected to fail
when written.

**Organization**: Grouped by user story, so each is separately implementable and
separately demonstrable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel — different files, no dependency on incomplete work
- **[Story]**: US1 / US2 / US3, mapping to the spec's user stories

## Path Conventions

This is an npm-workspaces monorepo. Real paths used below:

- Algorithm: `packages/shared/src/`
- Interface: `apps/web/src/`
- Storage: `supabase/migrations/`, `supabase/tests/database/`
- Tests: `tests/` at the repository root (never co-located)

## Two rules that shape the order below

**Translation keys ship with the component that reads them.** There is no bulk
"add all the strings" task, because `scripts/verify-i18n.mjs` fails on a key
nothing reads, and it runs inside `verify-all.mjs`, which CI runs on every pull
request. A key added a phase before its component is a red gate for every commit
in between. So each UI task adds its own strings to **both** the `en` and `uk`
maps in `apps/web/src/i18n.ts` — parity is separately enforced by
`tests/i18n.test.ts`.

**Registering a tool breaks three existing expectations on purpose.**
`tests/launcher.test.tsx` pins the exact tool list and the exact `analyticsId`
list with `toEqual`; `tests/tool-registry.test.tsx` pins the registered routes;
`tests/route-matrix-contract.test.ts` asserts that the only unswept router
routes are `/account`, `/admin` and `/auth/callback`. T020 updates all of them
in one place, immediately after registration — it is not optional cleanup.

## Machine note

This machine freezes under parallel load. `[P]` marks tasks that are _logically_
independent — run heavy gates (tsc, vitest, builds) one at a time anyway,
`nice -n 15`, and Vitest with
`--maxWorkers=1 --minWorkers=1 --no-file-parallelism`. Never run
`npm run verify` / `verify:release` locally; CI runs it for you.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The small, independent additions every later phase references.

- [x] T001 [P] Add `twoFactorNotebook` to the `FeatureId` union and to `featureFlags` with `protected: true` in `apps/web/src/lib/feature-flags.ts`, with a comment saying the tool ships behind the acknowledgement until it has been used against production data — unlike the stitcher, it waits on no agent release
- [x] T002 [P] Add `'two-factor'` to the `AnalyticsTool` union in `apps/web/src/analytics/events.ts`, with a comment that the identifier deliberately avoids the word "token" because `analytics_properties_are_safe_v2` rejects any property value matching `bearer|oauth|token=|authorization`
- [x] T003 [P] Add `TwoFactorIcon` to `apps/web/src/components/tool-icons.tsx` in the existing 32×32 stroked style of `CompressorIcon`/`StitcherIcon` — a key or shield-with-digits glyph, same stroke weight, no fill

**Checkpoint**: The catalogue vocabulary exists; nothing is wired yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The algorithm, the storage, the client wrappers, and the registry
change that lets a browser-only tool exist at all. Every user story depends on
this phase.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### The algorithm

- [x] T004 [P] Write `tests/totp.test.ts` covering everything in [`contracts/totp.md`](./contracts/totp.md): the six RFC 6238 appendix-B vectors including `20000000000` seconds (which catches a counter truncated to 32 bits), lowercase/spaced/padded Base32, rejection of `0` `1` `8` `9`, the four `TwoFactorSeedError` cases, `otpauth://` secret and label extraction, leading-zero preservation, and `totpStepEndsAt` landing on a 30 000 ms boundary. Expected to fail until T005
- [x] T005 Implement `packages/shared/src/totp.ts` — `parseTwoFactorSeed`, `generateTotp`, `totpStepEndsAt`, `TOTP_DIGITS`, `TOTP_STEP_SECONDS`, with module-private `decodeBase32`, `sha1`, `hmacSha1`, `dynamicTruncate`. Synchronous, zero dependencies, no DOM API and no Node built-in; `parseTwoFactorSeed` returns a discriminated result and never throws (research D2)
- [x] T006 Re-export the TOTP types and functions from `packages/shared/src/types.ts` alongside the other domain types, then rebuild the package: `nice -n 15 npm run build -w @video-compressor/shared` (its `dist` is committed and every consumer validates against it)

### The storage

- [x] T007 [P] Write `tests/two-factor-sql.test.ts` using `tests/support/team-db.ts` (which already stubs the `vault` schema): create/list round-trips the seed byte-identically; the seed is absent from `private.two_factor_entries`; a second `auth.uid()` lists nothing of the first's; a non-owner's `update` and `delete` both raise `ENTRY_NOT_FOUND` (the same code as a missing row, so ids cannot be probed); delete removes the `vault.secrets` row; a failed create leaves no orphaned secret; **two entries may carry the same name** (the spec allows duplicates, so assert the second insert succeeds); and a direct `select` as `authenticated` returns nothing. Expected to fail until T008
- [x] T008 Create `supabase/migrations/20260903100000_two_factor_notebook.sql` — the `private.two_factor_entries` table, index and check constraints from [`data-model.md`](./data-model.md); RLS enabled with `revoke all` and no client policy; the four `security definer` functions from [`contracts/rpc.md`](./contracts/rpc.md), each `set search_path = ''` with fully-qualified names, an `auth.uid()` null check, and `where owner = auth.uid()` on every statement; `revoke all … from public, anon` then `grant execute … to authenticated`; and the `exception when others then delete from vault.secrets …; raise;` guard on create, mirroring `private.store_google_drive_credential`
- [x] T009 Add the reverse steps for this migration to `supabase/migrations/ROLLBACK.md`, including that dropping the table must also delete the referenced `vault.secrets` rows
- [x] T010 [P] Add `supabase/tests/database/two-factor.test.sql` (pgTAP) asserting against a real Postgres what PGlite can only stub: RLS is enabled on the table, `authenticated` holds no direct grant, and the four functions are executable by `authenticated` but not by `anon`

### The client seam

- [x] T011 Hand-add the four function signatures to the `Functions` block of `apps/web/src/lib/database.types.ts`, following the precedent of feature 015 and repeating its comment: the committed types predate unrelated local-schema drift, so a wholesale `npm run types:supabase` regeneration would drag that drift into this diff
- [x] T012 Create `apps/web/src/api/two-factor.ts` — `listEntries`, `createEntry`, `updateEntry`, `deleteEntry` through `requireSupabaseClient().rpc(...)`, a total `mapEntry(row: unknown): TwoFactorEntry | null` in the style of `mapMember` in `api/team.ts` (mapping the row's `secret` column onto the entry's `seed` field — see [`contracts/rpc.md`](./contracts/rpc.md)), and a `TwoFactorApiError` carrying the machine codes (`INVALID_NAME`, `INVALID_SECRET`, `ENTRY_NOT_FOUND`, `NOT_AUTHENTICATED`, `INVALID_RESPONSE`, `UNKNOWN`). Reject the whole batch when any row maps to `null`; never surface a raw database string

### The registry change (research D5)

- [x] T013 Add `runtime: 'agent' | 'browser'` to the `WebTool` type in `apps/web/src/lib/tool-registry.ts`, widen `id` to `SotyToolId | BrowserToolId` with `BrowserToolId` declared there, set `runtime: 'agent'` on the five existing tools, and comment that a browser tool is deliberately absent from `WEB_TOOL_REQUIREMENTS` because that map is byte-compared against the signed `stable.json` by `verify-release.mjs`
- [x] T014 [P] Extend the existing `tests/tool-registry.test.tsx` (do not create a new file — it is `.tsx` and already holds six cases): a `runtime: 'browser'` tool opens from the home screen with the agent disconnected and never reaches `toolAvailable`, an agent tool still shows its setup dialog, and no browser tool id appears in `WEB_TOOL_REQUIREMENTS`. Expected to fail until T015–T016
- [x] T015 In `apps/web/src/HomePage.tsx`, make `openTool` navigate straight to a `runtime: 'browser'` tool after the feature-flag check, skipping the `connected && toolAvailable(tool.id)` gate and the setup panel
- [x] T016 In `apps/web/src/ProtectedSoty.tsx`, make `ToolRoute` render a `runtime: 'browser'` tool's page directly after the feature-lock check, never consulting `capabilities`, `toolAvailable`, `connectedOnce` or `ToolSetupScreen`

### The page skeleton

- [x] T017 Create `apps/web/src/two-factor/TwoFactorContext.tsx` in the house idiom — `createContext<T | null>(null)`, a `useTwoFactor()` that throws outside its provider, a `TwoFactorContextOverride` for tests — holding the entry list, a loading/error state, and the load-on-mount call to `listEntries`
- [x] T018 Create `apps/web/src/two-factor/TwoFactorPage.tsx` — the provider, the page shell in the compressor's `page-container` layout, the list region, and the "notebook is empty" empty state; add its strings (empty notebook, loading, load-failure) to `en` and `uk` in `apps/web/src/i18n.ts`
- [x] T019 Register the tool in `apps/web/src/lib/tool-registry.ts`: `id: 'twoFactor'`, `analyticsId: 'two-factor'`, `path: '/2fa'`, `runtime: 'browser'`, `capability: null`, the T003 icon, the T001 feature flag, `status: statusFor('twoFactorNotebook')`, and a lazy `import('../two-factor/TwoFactorPage')` — placed after the stitcher in the tile order; add the tool's label and catalogue description to `en` and `uk` in `apps/web/src/i18n.ts`
- [x] T020 Update the three expectations that registration breaks, in one pass: the two `toEqual` arrays in `tests/launcher.test.tsx` (the tool list at ~L17 and the `analyticsId` list at ~L29), the registered-routes case in `tests/tool-registry.test.tsx`, and — because `tests/route-matrix-contract.test.ts` asserts the unswept set is exactly `['/account','/admin','/auth/callback']` — add `'/2fa'` to `ROUTES` in `scripts/verify-a11y.mjs` so the new route is swept rather than silently skipped
- [x] T021 Add this feature's styles to `apps/web/src/styles.css` in one pass, against the existing tokens and the compressor's card language: the one-line row and its action cluster, the `2fa` marker and its revealed state, the code readout and its remaining-validity indicator, the pinned search bar (`position: sticky` with `--layer-sticky`), and the clock-skew warning line. One edit, because the file is 17k lines and repeated passes churn it

**Checkpoint**: `/2fa` opens with the agent closed, shows an empty notebook, the
existing suite is green again, and `nice -n 15 node scripts/verify-release.mjs`
still passes with no agent release.

---

## Phase 3: User Story 1 — Keep a secret and hand it over (Priority: P1) 🎯 MVP

**Goal**: Entries can be added and their seeds copied. This alone replaces the
text file.

**Independent Test**: Add two entries, reload in a fresh session as the same
person, confirm both rows are present and that the copy button puts the exact
original seed on the clipboard.

### Tests for User Story 1

- [x] T022 [P] [US1] Create `tests/two-factor-ui.test.tsx` with a `// @vitest-environment jsdom` docblock, mocking `api/two-factor.ts` via `vi.hoisted` + `vi.mock`: saving a valid seed adds one row showing the name and a `2fa` marker rather than the seed; an invalid seed is rejected with the message for its error code and nothing is sent; an `otpauth://` URI fills the name from its label when the name field is empty; the copy button calls `navigator.clipboard.writeText` with the stored seed unchanged and without a preceding reveal; a rejected `writeText` raises the error toast, not the success one, and leaves the value selectable. Expected to fail until T023–T028

### Implementation for User Story 1

- [x] T023 [US1] Create `apps/web/src/two-factor/clipboard.ts` — a `copyText(value)` helper that calls `navigator.clipboard.writeText` synchronously from the caller's handler, returns a success/failure result rather than throwing, and never reports success on a rejected write (FR-018)
- [x] T024 [US1] Create `apps/web/src/two-factor/TwoFactorForm.tsx` — one form used for both adding and editing: a required name, a seed field, validation through `parseTwoFactorSeed` before submit, and the `otpauth://` label pre-filling an empty name (FR-009 – FR-011); add its strings — the field labels, the save and cancel actions, and one message per `TwoFactorSeedError` (`EMPTY`, `NOT_BASE32`, `TOO_SHORT`, `URI_WITHOUT_SECRET`) — to `en` and `uk` in `apps/web/src/i18n.ts`
- [x] T025 [US1] Create `apps/web/src/two-factor/TwoFactorRow.tsx` — one line carrying the name, the `2fa` marker, and the copy-seed button, with the row's actions as lucide icon buttons sized by the house `ICON_SIZE` / `ICON_STROKE` from `apps/web/src/components/icons.tsx`, each with an accessible label (FR-004, FR-014, FR-022, FR-024); add the button labels to `en` and `uk` in `apps/web/src/i18n.ts`
- [x] T026 [US1] Add the per-entry reveal to `TwoFactorRow.tsx` — shows that one entry's seed in place, resets on unmount and reload, and is never required before copying (FR-023, FR-024); add its label to both dictionaries
- [x] T027 [US1] Wire `createEntry` through `TwoFactorContext.tsx`, appending the returned row without refetching, and surfacing a `TwoFactorApiError` as its i18n message
- [x] T028 [US1] Add the copy-confirmation and copy-failure toasts through the existing toast provider (strings in both dictionaries), and emit analytics using the **existing** names in `analyticsEventNames` — `tool_opened` on entry, `feature_enabled` for a completed add — with `tool_identifier: 'two-factor'` and no seed-shaped property. Do not widen the event-name union: it is closed on purpose and the database independently checks `event_name ~ '^[a-z][a-z0-9_]{1,63}$'` (FR-008, FR-018)

**Checkpoint**: The notebook stores seeds and hands them back. Independently
demonstrable; quickstart scenario 1 already passes from Phase 2.

---

## Phase 4: User Story 2 — One press: code generated and copied (Priority: P2)

**Goal**: One press writes the current six-digit code into the row and onto the
clipboard.

**Independent Test**: With one stored entry whose seed is known, press
generate-and-copy and compare the shown code against a standard authenticator
app holding the same seed at the same moment.

### Tests for User Story 2

- [x] T029 [P] [US2] Extend `tests/two-factor-ui.test.tsx`: pressing generate-and-copy writes six digits into the row and calls `writeText` with the same string, with **no promise resolved between the click and the write** (assert by resolving nothing in between — research D3); a code stops being presented as current once its step has passed; two presses inside one step show the same digits. Expected to fail until T030–T033

### Implementation for User Story 2

- [x] T030 [US2] Add the generate-and-copy button to `apps/web/src/two-factor/TwoFactorRow.tsx` — computes the code with the synchronous `generateTotp` and calls `copyText` in the same handler turn, before any `await` (FR-015); add its label to `en` and `uk`
- [x] T031 [US2] Display the generated code on the row and hold it in page state keyed by entry id, as the transient `GeneratedCode` shape from [`data-model.md`](./data-model.md) — never persisted, never sent anywhere
- [x] T032 [US2] Show how much of the code's window remains, from `totpStepEndsAt`, and drop the code once that moment passes so a stale code is never presented as current (FR-017)
- [x] T033 [US2] Create `apps/web/src/two-factor/clock-skew.ts` — one `HEAD` request to the page's own origin on open, comparing the response `Date` header with `Date.now()`; beyond ±10 s, render the warning line above the list (string in both dictionaries). A failed or header-less response shows nothing (research D6)

**Checkpoint**: The everyday action works. US1 and US2 both stand alone.

---

## Phase 5: User Story 3 — Find, correct, remove (Priority: P3)

**Goal**: A grown list stays usable: search from the top, edit a row, delete a
row.

**Independent Test**: With a dozen entries, type a fragment of one name and then
of one seed and confirm the list narrows each time; rename one entry and delete
another, then reload to confirm both stuck.

### Tests for User Story 3

- [x] T034 [P] [US3] Extend `tests/two-factor-ui.test.tsx`: typing filters on name and on seed, case-insensitively and as you type; a query matching nothing shows the "nothing matches" state and not the "notebook is empty" one; editing a name keeps the row's position; editing a seed changes the codes generated afterwards; delete asks for confirmation and removes the row. Expected to fail until T035–T040

### Implementation for User Story 3

- [x] T035 [US3] Add the pinned search field to `apps/web/src/two-factor/TwoFactorPage.tsx`, staying visible while a long list scrolls (FR-019); add its placeholder and accessible label to `en` and `uk`
- [x] T036 [US3] Filter the in-memory entries on name **and** seed, case-insensitively, updating as the person types — no round trip, so 200 entries narrow within a frame (FR-020, SC-004)
- [x] T037 [US3] Add the "nothing matches" empty state, distinct from the empty-notebook state (FR-021); string in both dictionaries
- [x] T038 [US3] Add the edit button to `TwoFactorRow.tsx` and reuse `TwoFactorForm.tsx` in edit mode, pre-filled, sending `null` for the seed when only the name changed (FR-012, contract `update_two_factor_entry`)
- [x] T039 [US3] Add the delete button with its confirmation, and wire `deleteEntry` through the context, removing the row from state on success (FR-012); confirmation strings in both dictionaries
- [x] T040 [US3] Keep the list order stable across an edit — `updated_at` moves, `created_at` does not, and the client preserves the server's `created_at desc, id` order (FR-013)

**Checkpoint**: All three stories work independently.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T041 [P] Truncate an over-long name in the row while keeping it fully readable via its title attribute and fully searchable (spec edge case)
- [x] T042 [P] Make every row reachable and operable by keyboard, and confirm the icon-button labels added in T025/T026/T030/T038/T039 read correctly to a screen reader (FR-004)
- [x] T043 [P] Write `docs/TWO_FACTOR_NOTEBOOK.md` in the shape of `docs/VIDEO_STITCHER.md`, covering the vault storage, the owner-scoped RPCs, and why the algorithm is hand-written and synchronous
- [x] T044 [P] Add a 2FA notebook section to `TESTER_GUIDE.md` beside the stitcher's, in the guide's existing bilingual style
- [x] T045 Measure the two success criteria that only have implementation so far: load 200 entries, type three characters and confirm the list narrows within 300 ms (SC-004); and take a screenshot immediately after opening a notebook of ten entries and confirm no seed is readable on it (SC-009)
- [x] T046 Confirm no seed escapes: run an add–copy–generate–edit–delete pass with devtools open and check console, network (seeds only in the `list_two_factor_entries` response body, never in a URL or header) and every analytics payload (SC-007, FR-008)
- [x] T047 Run the quickstart's browser pass end to end, including opening the tool with the agent **not running**, a second-device check, and the wrong-clock warning — [`quickstart.md`](./quickstart.md) scenarios 4 and 5
- [x] T048 Run the gates one at a time, `nice -n 15`: `npm run format:check`, then `npm run lint`, then `npm run typecheck`, then the feature's tests plus the three suites T020 touched (`tests/totp.test.ts`, `tests/two-factor-sql.test.ts`, `tests/two-factor-ui.test.tsx`, `tests/tool-registry.test.tsx`, `tests/launcher.test.tsx`, `tests/route-matrix-contract.test.ts`, `tests/i18n.test.ts`) with `--maxWorkers=1 --minWorkers=1 --no-file-parallelism`
- [x] T049 Run `nice -n 15 node scripts/verify-release.mjs` and confirm it passes **without** an agent release; a `stable.json` complaint means something reached `WEB_TOOL_REQUIREMENTS` that should not have (research D5)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Needs T001–T003 for the flag, the analytics id and the icon — BLOCKS all user stories
- **User Stories (Phases 3–5)**: All depend on Phase 2. They may then proceed in parallel, or sequentially in priority order
- **Polish (Phase 6)**: Depends on the stories being delivered

### Within Phase 2

```text
T004 ──▶ T005 ──▶ T006            (algorithm: test, implement, export+build)
T007 ──▶ T008 ──▶ T009            (storage: test, migrate, document rollback)
T010                              (pgTAP, independent of the PGlite chain)
T008 ──▶ T011 ──▶ T012            (types before the client wrappers)
T013 ──▶ T015, T016               (the type change before its two call sites)
T014 ──▶ T015, T016               (test first)
T012 ──▶ T017 ──▶ T018 ──▶ T019   (wrappers, context, page, then registration)
T019 ──▶ T020                     (T020 repairs exactly what T019 breaks — do not defer it)
T021                              (styles, independent)
```

### User Story Dependencies

- **US1 (P1)**: Needs only Phase 2. Nothing else depends on it
- **US2 (P2)**: Needs only Phase 2. Shares `TwoFactorRow.tsx` with US1, so if both are built at once, T030 lands after T025
- **US3 (P3)**: Needs only Phase 2. Shares `TwoFactorForm.tsx` (T038 after T024) and `TwoFactorRow.tsx` (T038/T039 after T025) with US1

### Parallel Opportunities

- **Phase 1**: T001, T002, T003 are three different files — parallel
- **Phase 2**: the three tracks — algorithm (T004–T006), storage (T007–T010), registry (T013–T016) — touch disjoint files and can run side by side. T021 is independent of all of them
- **Phase 6**: T041–T044 are four different files

Logically parallel; on this machine, still run heavy gates one at a time.

---

## Parallel Example: Phase 2

```bash
# Three independent tracks, one heavy process at a time:
Task: "Write tests/totp.test.ts with the RFC 6238 vectors"            # T004
Task: "Write tests/two-factor-sql.test.ts against PGlite"              # T007
Task: "Extend tests/tool-registry.test.tsx for browser-runtime tools"  # T014
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 — Setup
2. Phase 2 — Foundational (blocks everything; ends with `/2fa` opening on an empty notebook while the agent is closed, and the existing suite green again)
3. Phase 3 — User Story 1
4. **Stop and validate**: add entries, reload, copy a seed
5. Demo — at this point the notebook already replaces the text file

### Incremental delivery

1. Setup + Foundational → the tool exists and opens
2. - US1 → seeds stored and copyable (**MVP**)
3. - US2 → one press for a code, the everyday action
4. - US3 → search, edit, delete for a grown list
5. Polish → docs, accessibility, the measured criteria, the no-seed-escapes pass, the gates

### Release

The feature ships behind the `twoFactorNotebook` acknowledgement flag (T001).
Flipping `protected` to `false` in `apps/web/src/lib/feature-flags.ts` releases
it — no agent release is involved, and `verify-release.mjs` must keep passing
without one (T049).

---

## Notes

- `[P]` = different files, no dependency — but see the machine note above
- Each user story is independently completable and demonstrable
- Write each test task before the implementation it covers and watch it fail
- Commit after each task or logical group
- Never add this tool to `WEB_TOOL_REQUIREMENTS`; that is the whole point of T013
- **The name is spelled differently in each namespace on purpose**, as the
  stitcher's already is (`stitcher` ↔ `videoStitcher`): tool id `twoFactor`,
  feature flag `twoFactorNotebook`, analytics `two-factor`, route `/2fa`,
  directory `two-factor/`, table `two_factor_entries`. Each follows its own
  namespace's convention — do not "unify" them

---

## What the final pass actually found

- **T049 does not pass, and not because of this feature.**
  `scripts/verify-release.mjs` fails on `stable release manifest tool
requirements differ from the web contract`, and it fails identically with this
  branch stashed. The difference is `stitcher`, which feature 014 added to
  `WEB_TOOL_REQUIREMENTS` and which the published `stable.json` will not carry
  until its agent release ships — the gate behaving as designed. `twoFactor`
  appears on neither side, which is the outcome D5 asked for.
- **`npm run lint` is red on this repository, in files this feature never
  touched** (`App.tsx`, `JobRow.tsx`, `SettingsPanel.tsx`,
  `settings-validation.ts` — unused imports). Verified pre-existing by linting
  them with the working tree's one unrelated modification stashed. Linting this
  feature's own files reports nothing.
- **Two defects were found and fixed during the browser pass**, neither visible
  to the test suite: the form's inputs had no accessible name (a wrapping
  `<label>` left them anonymous in Chrome's accessibility tree — now explicit
  `htmlFor`/`id`), and the page used `.page-container` with a heading while
  every other tool page uses `.workspace` without one, which made the notebook
  the one tool that did not look like the compressor.
- **Not exercised:** the clock-skew _warning_ branch. The measurement was
  verified live (the `Date` header returns, the offset computed as −1 s, no
  warning shown, which is the correct outcome); triggering the warning needs the
  system clock moved, which was not done. Second-device sign-in (SC-005) was not
  exercised either — the storage is server-side and the SQL suite covers
  ownership, but nobody has signed in twice.

---

## After the first pass: the owner's design

The owner supplied three design frames after the feature was working, and the
interface was rebuilt to them. What changed, and what did not:

- **Not the algorithm, the storage, or the contracts.** `totp.ts`, the migration,
  the four RPCs and `api/two-factor.ts` are untouched. Every decision in
  `research.md` still holds — including the synchronous clipboard rule, which the
  new quick-code bar depends on exactly as the rows do.
- **A new requirement, asked for explicitly**: a pinned field for a key that is
  _not_ stored — paste it, take the code, save nothing (FR-025 – FR-027).
- **The list became a table** (FR-028 – FR-030): a header carrying the brand, the
  search with its ⌘K hint, sorting and the add control; checkboxes and a bulk
  delete; one labelled `Скопіювати код` per row with the code appearing in the
  row that produced it; editing in the row itself, which also serves as the add
  form — so `TwoFactorForm.tsx` was deleted rather than kept beside it.
- **The key stopped being a column.** Copying and revealing it moved into the
  row's overflow menu (FR-022 – FR-024 restated), which is stricter than before:
  the resting table shows no key at all.
- **Three defects found while checking against the frames**: the edit row's two
  fields widened the table past its own frame and pushed confirm/cancel off the
  right edge (fixed with `table-layout: fixed`); the frame's `overflow: hidden`
  clipped the row's own overflow menu (fixed by rounding the corner cells
  instead); and the header sat on the honeycomb, where the brand and the search
  lost their contrast (the tool is one panel now).

---

## A design review, and what it changed

Asked to grade the interface independently, I gave it 6.5 and named six things.
All six are now done.

The one that mattered: **the tool showed no codes.** Six accounts, and the most
useful thing it knows was behind a click, which left several hundred pixels of
nothing on every row between a name and a button. Codes are now live for every
account under one shared countdown, and the digits are the button that copies
them — one target instead of two, and the void filled with the product itself.

The rest followed from it or stood on its own:

- **Capped at 1180px.** Two meaningful columns do not improve with a wider
  monitor; they move further apart than the eye can carry a row.
- **The quick-code field got a heading.** It was a wide input with a placeholder
  directly under a wide input with a placeholder, and people would have typed
  account searches into it. It also answers as the key is pasted now, with
  nothing to press.
- **The orange came off Додати.** It was the loudest thing on screen and the
  rarest action; the accent is spent on the codes instead.
- **The pencil moved into the overflow menu**, and the labelled copy button went
  away with the code becoming its own button — four targets a row down to two.
- **Rows from 78px to 61px**, and the checkboxes appear only when the table is
  touched.

Two things the review did not ask for but the change made necessary: one step
counter and one idle watch for the whole page (`totp-clock.ts`) rather than a
timer per row, and a blur over the digits after two minutes without interaction —
codes may be on screen because they expire in thirty seconds, but a wallet left
open on a desk is still a wallet left open.
