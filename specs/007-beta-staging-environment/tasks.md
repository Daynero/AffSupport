---

description: "Task list for the Beta Staging Environment feature"
---

# Tasks: Beta Staging Environment

**Input**: Design documents from `/specs/007-beta-staging-environment/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Test tasks ARE included. The constitution makes `npm test` a mandatory pre-PR gate and requires all tests in the central `tests/` directory as `*.test.ts(x)`; `contracts/beta-guard-contract.md` names the required suites and what each must assert. The guards are this feature's whole value — an unverified guard is an absent guard.

**Organization**: Grouped by user story so each story is independently implementable and testable.

**Revision**: Updated after `/speckit-analyze` (2026-08-20). The analysis found one critical gap — outbound invitation mail bypasses the local capture sink and reaches a real third-party delivery provider — plus eleven smaller issues. All are folded in below; see the Notes section for what changed.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story the task belongs to (US1–US4)
- Exact file paths are included in every task

## Path Conventions

Monorepo, per [plan.md](./plan.md): `packages/shared/src/`, `apps/agent/src/`, `apps/web/src/`, `scripts/`, `supabase/`, `tests/`, `docs/`. All paths below are repository-relative.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Put the committed placeholders and key material in place so nothing later has to invent them.

- [X] T001 Create the committed beta profile template `.env.beta.example` at the repository root, containing every key from `specs/007-beta-staging-environment/contracts/beta-environment-contract.md` with placeholder values only, and including `RESEND_API_KEY=` and `INVITE_EMAIL_FROM=` **explicitly empty** with a comment stating that a delivery-provider credential is forbidden in beta (FR-027a, FR-027e)
- [X] T002 Add `!.env.beta.example` to `.gitignore` immediately after the existing `!.env.example` negation, so the template is tracked while `.env.beta` stays ignored by the existing `.env.*` rule
- [X] T003 [P] Extend `scripts/generate-signing-keys.mjs` with a `--beta` flag that generates a `beta-agent-entitlement` ECDSA P-256 keypair into `config/keys/`, refusing to overwrite an existing key exactly as the current targets do
- [X] T004 [P] Create `docs/BETA.md` with the six section headings FR-013 requires — Prerequisites, Start, Stop, Reset, Promotion, Troubleshooting — plus an empty "Flows exercisable in beta" table to be filled in T031

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The environment identity every guard, script, badge, and gate keys on. Nothing else can be built first.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T005 Create `packages/shared/src/environment.ts` defining `AppEnvironment = 'production' | 'beta'` and `parseAppEnvironment(value: unknown)` returning the discriminated result `{ ok: true; value } | { ok: false; error }`, treating absent/empty as `production` and any other string as an error naming the offending value (never coerced, case-sensitive)
- [X] T006 Add the `EnvironmentProfile` declarations to `packages/shared/src/environment.ts` — agent port, web port, app name, bundle id, support directory name, instance lock name, and release channel for the production, dev, and beta profiles, per the table in `specs/007-beta-staging-environment/data-model.md`
- [X] T007 Add `isLoopbackOrigin(value)` and `isProductionEndpoint(value)` helpers to `packages/shared/src/environment.ts`, reusing `PRODUCTION_SITE_ORIGIN` from `packages/shared/src/release.ts` rather than re-declaring any origin
- [X] T008 Export the environment module from `packages/shared/src/index.ts` and rebuild with `npm run build -w @video-compressor/shared` so the committed `dist` carries it (Constitution Principle II)
- [X] T009 [P] Create `tests/beta-environment.test.ts` asserting the parser rules from T005 and that agent port, bundle id, support directory name, and instance lock name are pairwise distinct across the production, dev, and beta profiles
- [X] T010 Add an `environment` field to the config object in `apps/agent/src/config.ts`, parsed from `SOTY_ENVIRONMENT` via `parseAppEnvironment`, defaulting to `production` and throwing on an unparseable value
- [X] T011 Add the `environment` field to the health snapshot in `apps/agent/src/server/app.ts` as an additive change to the existing shape, so older clients are unaffected
- [X] T012 [P] Declare `VITE_APP_ENVIRONMENT` in `apps/web/src/vite-env.d.ts` alongside the existing `VITE_LOCAL_DEV_AUTH` declaration
- [X] T013 Make `validatePublicConfig` in `apps/web/src/lib/config.ts` environment-aware: parse `VITE_APP_ENVIRONMENT`, permit loopback `VITE_SITE_URL` / `VITE_SUPABASE_URL` in a production *build* only when the environment is `beta`, and keep the existing rejection of loopback origins for `production`
- [X] T014 [P] Add **every** beta-related string to the `TranslationKey` union and both locales in `apps/web/src/i18n.ts` in one pass — the environment badge, the about-surface environment label, the external-storage unavailable-in-beta notice, and the locally-surfaced invitation notice — so no later story has to reopen this file

**Checkpoint**: The environment identity exists end to end. User stories can begin.

---

## Phase 3: User Story 1 — Run a production-equivalent copy from the beta line (Priority: P1) 🎯 MVP

**Goal**: One command brings up a complete, working copy of the product on the maintainer's machine, backed by the local Supabase stack, with real authentication and real entitlement, and nothing — no telemetry, no account, no message — reaching the outside world.

**Independent Test**: On a clean checkout, run `npm run beta:up`, complete authenticate → pair → run one media job → view result → send a team invitation, all with no third-party account; then confirm via `npm run analytics -- overview --days 1` that production analytics recorded nothing, that no production account exists, and that the invitation was surfaced locally rather than delivered.

### Tests for User Story 1

- [X] T015 [P] [US1] Create `tests/beta-isolation-guards.test.ts` covering every Guard A row in `specs/007-beta-staging-environment/contracts/beta-guard-contract.md` — each condition produces its exact machine code (`BETA_PRODUCTION_ENDPOINT`, `BETA_ENV_MISSING`, `BETA_LOCAL_AUTH_FORBIDDEN`, `BETA_PORT_IN_USE`, `BETA_PREREQUISITE_MISSING`, `BETA_DELIVERY_PROVIDER_FORBIDDEN`) and a valid beta profile passes. Environment probes (container runtime, CLI presence, port binding) are injected as parameters so the suite is deterministic and never touches the real system
- [X] T016 [P] [US1] Create `tests/beta-analytics.test.ts` asserting the analytics service emits nothing when the environment is `beta` **even with `VITE_ANALYTICS_ENABLED=true`**, and still emits normally in `production`

### Implementation for User Story 1

- [X] T017 [US1] Make analytics suppression structural in `apps/web/src/analytics/service.ts`: the existing `ANALYTICS_ENABLED` flag is ANDed with `environment !== 'beta'`, so a bad env file cannot re-enable telemetry (research R5)
- [X] T018 [US1] Add the beta isolation assertion to `apps/agent/src/config.ts`, running before the server binds: when the environment is `beta`, reject any non-loopback `PUBLIC_SITE_ORIGIN`/`DEV_SITE_ORIGIN`, reject an empty or production `AGENT_ENTITLEMENT_PUBLIC_KEY`, and fail with `BETA_PRODUCTION_ENDPOINT` naming the offending variable
- [X] T019 [US1] Add the beta-side rejections to `apps/web/src/lib/config.ts`: when the environment is `beta`, any non-loopback Supabase/site/agent URL or any value equal to `PRODUCTION_SITE_ORIGIN` is a configuration error carrying `BETA_PRODUCTION_ENDPOINT`
- [X] T020 [P] [US1] Create `scripts/verify-beta-env.mjs` — the doctor. Checks: container runtime, Supabase CLI, FFmpeg/FFprobe; `.env.beta` presence and every required key; isolation per Guard A; **that no third-party delivery-provider credential is set, failing with `BETA_DELIVERY_PROVIDER_FORBIDDEN`** (FR-027e); port availability for 43140/5175/54321–54324; **that the agent and web server bind only the loopback interface** (FR-009a). Reports **all** problems in one pass with a remedy per line, prints **both** the source revision the copy will run and how far `beta` is behind `main` (FR-011), takes its environment probes as injectable functions so T015 can drive it, and follows the repository `fail()` → stderr + `process.exit(1)` convention
- [X] T021 [P] [US1] Add `http://127.0.0.1:5175` and `http://127.0.0.1:43140` to `additional_redirect_urls` in `supabase/config.toml` so real sign-in against the local stack can complete (the one deviation recorded in plan.md Complexity Tracking)
- [X] T022 [P] [US1] Document the beta values for the local function environment in `supabase/functions/.env.example` comments — beta `AGENT_TOKEN_PRIVATE_KEY`, `WISHLY_SITE_URL=http://127.0.0.1:5175`, `DRIVE_OAUTH_MODE=disabled`, and **`RESEND_API_KEY` / `INVITE_EMAIL_FROM` left empty in beta** — without placing any real key in the tracked file
- [X] T023 [US1] Contain invitation delivery in beta: `supabase/functions/team-invitations/index.ts` and `supabase/functions/team-invitations/email.ts` post directly to `https://api.resend.com/emails`, bypassing the local mail catcher entirely. When no delivery-provider credential is configured, return the invitation link in the response instead of attempting delivery, and surface it in the web invitation UI using the string added in T014, so an invitation can be exercised end to end without any message leaving the machine (FR-027a, SC-013)
- [X] T024 [US1] Create `scripts/beta-up.mjs` — runs the doctor first, then starts the local Supabase stack, the agent, and Vite in `--mode beta`; spawns with `spawn(cmd, args, { shell: false })`, tracks child PIDs, bounds captured stderr, and prints the beta URL on success (Constitution Principle IV)
- [X] T025 [US1] Create `scripts/beta-down.mjs` — stops every tracked child with SIGTERM escalating to SIGKILL on a `.unref()`'d timer, stops the Supabase stack, verifies the beta ports are released, and exits non-zero naming anything that would not stop
- [X] T026 [US1] Add `dev:beta` (`vite --mode beta --host 127.0.0.1 --port 5175 --strictPort`) and `build:beta` (`tsc -b && vite build --mode beta`) to `apps/web/package.json`
- [X] T027 [US1] Add `beta:doctor`, `beta:up`, and `beta:down` to the root `package.json` scripts, each preceded by `npm run build -w @video-compressor/shared` so no script reads a stale shared `dist` (Constitution Principle II)
- [X] T028 [P] [US1] Mark the Drive connection surface unavailable in beta when external storage is not configured, in `apps/web/src/team/drive/DriveConnectionPanel.tsx`, so the flow never falls through to the production integration (FR-027d)
- [X] T029 [P] [US1] Apply the same unavailable-in-beta treatment to the Drive step of `apps/web/src/team/create/ConnectFolderStep.tsx` so space creation reports the limitation rather than failing opaquely
- [X] T030 [US1] Fill the Prerequisites, Start, and Stop sections of `docs/BETA.md`, including the exact one-time setup (`cp .env.beta.example .env.beta`, `node scripts/generate-signing-keys.mjs --beta`) and the local stack's default ports
- [X] T031 [US1] Fill the "Flows exercisable in beta" table in `docs/BETA.md` — out of the box, requiring the opt-in Drive setup, and not exercisable at all — and state explicitly that invitations are surfaced locally rather than delivered (FR-028)
- [X] T032 [US1] Document the opt-in external-storage setup in `docs/BETA.md`: creating a maintainer-owned Google test client, the loopback callback `http://127.0.0.1:54321/functions/v1/drive-oauth-callback` already present in `supabase/functions/.env.example`, and switching the local mode to `testing`

**Checkpoint**: A full production-equivalent copy runs locally with real auth and real entitlement, and provably touches nothing outside the machine — no telemetry, no accounts, no messages. **This is the MVP.**

---

## Phase 4: User Story 2 — Tell beta apart from production at a glance (Priority: P1)

**Goal**: A running beta copy is unmistakable to any observer, and beta artifacts are structurally incapable of being released or offered as an update.

**Independent Test**: Screenshot a running beta copy and a production copy — an observer identifies each correctly. Then run `SOTY_ENVIRONMENT=beta npm run release:check` and confirm it exits 1 with `RELEASE_BETA_IDENTITY`.

### Tests for User Story 2

- [X] T033 [P] [US2] Create `tests/beta-web-environment.test.tsx` (jsdom docblock) asserting the badge renders on a main screen in `beta`, is absent in `production`, and that the about surface shows the environment and the source revision
- [X] T034 [P] [US2] Create `tests/beta-release-gates.test.ts` asserting each beta marker in each production-feeding file is rejected with `RELEASE_BETA_CONFIG`; a beta channel/version is rejected with `RELEASE_BETA_IDENTITY`; a beta artifact is never verifiable by the production release-manifest key (FR-016a); and — critically — that `supabase/config.toml` containing beta redirect URLs does **not** trigger a failure

### Implementation for User Story 2

- [X] T035 [P] [US2] Create `apps/web/src/components/EnvironmentBadge.tsx` — a functional component reading the environment from `apps/web/src/lib/config.ts` and rendering nothing in `production`, styled with `className` only, using the strings added in T014
- [X] T036 [US2] Render `EnvironmentBadge` from `apps/web/src/Root.tsx` so it is persistent on every main screen with no scrolling or menu interaction required (FR-014)
- [X] T037 [P] [US2] Add the badge styles to `apps/web/src/styles.css` using the existing CSS custom properties and `data-theme` conventions, so the indicator is legible in both themes
- [X] T038 [US2] Show the environment name and the exact source revision (`VITE_WEB_REVISION`, already injected by `apps/web/vite.config.ts`) in the version detail block of `apps/web/src/pages/AccountPage.tsx` (FR-015)
- [X] T039 [US2] Skip the production update-manifest fetch when the environment is `beta` in `apps/web/src/release-manifest.ts`, so a beta copy never queries the production channel and never offers a production download (FR-018, research R11)
- [X] T040 [US2] Add the Guard B checks to `scripts/verify-release.mjs`: reject a beta release channel, version, or build id with `RELEASE_BETA_IDENTITY`, and scan the production-feeding file set plus the built `apps/web/dist` for the beta markers listed in `contracts/beta-guard-contract.md`, failing with `RELEASE_BETA_CONFIG` naming the offending file and value
- [X] T041 [US2] Encode the exempt-file rule explicitly in `scripts/verify-release.mjs` — `supabase/config.toml` is outside the scanned set by design — with a comment stating why, so the scope can neither widen by accident nor produce a false failure
- [X] T042 [US2] Assert in `scripts/verify-published-release.mjs` that no artifact carrying a beta identity appears in the published update channel, failing with `RELEASE_BETA_IDENTITY`

**Checkpoint**: Beta is visibly and structurally distinct. A beta artifact cannot be released or served as an update.

---

## Phase 5: User Story 3 — Promote tested work from beta to a real release (Priority: P2)

**Goal**: A packaged beta build exercises the real packaging behaviour, and nothing reaches production without having been verified on it.

**Independent Test**: Run `npm run beta:package` then `npm run beta:verify`, confirm `release/beta/verification.json` is written and production identity files are untouched; then confirm `npm run release:check` fails with `RELEASE_BETA_UNVERIFIED` for a commit not contained in `beta` and for a stale verification record.

### Tests for User Story 3

- [X] T043 [P] [US3] Create `tests/beta-promotion-gate.test.ts` asserting `RELEASE_BETA_UNVERIFIED` when HEAD is not contained in `beta`, when no verification record exists, when the record's `sourceRevision` differs from HEAD, and when the record is marked `dirty`

### Implementation for User Story 3

- [X] T044 [US3] Create `scripts/package-beta-mac.sh` (zsh, `set -euo pipefail`) modelled on `scripts/package-dev-mac.sh` but rendering the launcher with the beta profile — port 43140, app name `Soty Beta`, bundle id `com.wishly.beta`, lock `wishly-beta-agent.lock`, support directory `Soty Beta`, channel `beta`, version `<PRODUCT_VERSION>-beta.<sha>[.dirty].<stamp>` derived from `PRODUCT_VERSION` rather than forked from it
- [X] T045 [US3] In `scripts/package-beta-mac.sh`, build the web bundle with `VITE_APP_ENVIRONMENT=beta`, `VITE_ANALYTICS_ENABLED=false`, and **`VITE_LOCAL_DEV_AUTH=false`** — the deliberate divergence from the dev script, so beta authenticates for real (research R3)
- [X] T046 [US3] In `scripts/package-beta-mac.sh`, embed the **beta** `AGENT_ENTITLEMENT_PUBLIC_KEY` so the entitlement gate is genuinely enforced and a production token is cryptographically invalid in beta (research R4)
- [X] T047 [US3] Add the production side-effect guard to `scripts/package-beta-mac.sh`: capture and re-check `git status --porcelain` for `packages/shared/src/release.ts`, `apps/web/public/.well-known/wishly/stable.json`, `config/production.env`, `packaging/`, and `supabase/migrations/`, and refuse to proceed or exit non-zero if any would change; never create a git tag and never invoke a Cloudflare deployment — the full list the constitution names for dev/test builds
- [X] T048 [US3] Create `scripts/verify-beta-package.sh` modelled on `scripts/verify-dev-package.sh` — asserts bundle id `com.wishly.beta`, display name `Soty Beta`, channel `beta`, port 43140, lock name, support directory, a non-empty beta entitlement key, that the agent binds only the loopback interface (FR-009a), and that the built bundle contains no `VITE_LOCAL_DEV_AUTH=true`
- [X] T049 [US3] Have `scripts/verify-beta-package.sh` write `release/beta/verification.json` with `sourceRevision`, `buildId`, `verifiedAt`, and `dirty` **only after** every assertion passes, so a failed smoke leaves no record
- [X] T050 [US3] Create `scripts/verify-beta-promotion.mjs` asserting the release commit is contained in `beta` (`git merge-base --is-ancestor HEAD beta`) and that a verification record exists whose `sourceRevision` equals HEAD and whose `dirty` is `false`; before returning a verdict it MUST print the divergence between the lines — the commits in `main..beta` and in `beta..main` — so a decision that needs a human is visible before anything is published (FR-023). Fails with `RELEASE_BETA_UNVERIFIED` naming which condition failed
- [X] T051 [US3] Add `beta:package` and `beta:verify` to the root `package.json` scripts, each preceded by `npm run build -w @video-compressor/shared` (Constitution Principle II)
- [X] T052 [US3] Chain `node scripts/verify-beta-promotion.mjs` into `deploy:web`, `deploy:web:identity`, `deploy:web:member-pilot`, and `package:mac` in the root `package.json`, in the position shown in `contracts/beta-cli-contract.md` — after `verify-release`, before `verify-published-release`
- [X] T053 [US3] Fill the Promotion section of `docs/BETA.md`: the branch topology (feature work → `beta` → verify → merge to `main` → release), the exact command sequence, and what each gate rejects
- [X] T054 [US3] Add a short beta-workflow pointer to `AGENTS.md` so the runtime guidance stays consistent with the constitution's requirement that it match the principles

**Checkpoint**: Verified beta work promotes cleanly, and unverified work cannot reach production.

---

## Phase 6: User Story 4 — Reset beta to a known-clean state (Priority: P3)

**Goal**: One command returns beta to a documented, fixture-seeded baseline, and can never affect production.

**Independent Test**: Dirty the environment with several jobs and accounts, run `npm run beta:reset`, and confirm the baseline is restored in under 5 minutes and Scenario 1's journey succeeds immediately afterwards. Then confirm a non-loopback target fails with `BETA_RESET_TARGET_UNSAFE` before any write.

### Tests for User Story 4

- [X] T055 [P] [US4] Create `tests/beta-reset-guard.test.ts` asserting a non-loopback database target fails with `BETA_RESET_TARGET_UNSAFE` **before** the first destructive operation, regardless of how the target is supplied

### Implementation for User Story 4

- [X] T056 [P] [US4] Create `supabase/fixtures/beta-seed.sql` seeding the documented fixtures with fixed identifiers — one confirmed, active beta account (`beta@soty.local`), one team workspace owned by it, and one small sample media item — containing no copy of production data
- [X] T057 [US4] Create `scripts/beta-reset.mjs` — validates the target is loopback first, then runs `supabase db reset` (re-applying all migrations), applies `supabase/fixtures/beta-seed.sql` explicitly rather than as a shared seed so ordinary development is unaffected, and clears the `Soty Beta` Application Support directory where queue state, caches, and entitlement state live
- [X] T058 [US4] Add `beta:reset` to the root `package.json` scripts, preceded by `npm run build -w @video-compressor/shared` (Constitution Principle II)
- [X] T059 [US4] Fill the Reset section of `docs/BETA.md`, listing exactly what the baseline contains and what the fixtures provide

**Checkpoint**: Beta is reproducible. All four stories are independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T060 Fill the Troubleshooting section of `docs/BETA.md` with the most common startup failures and their remedies, keyed by the machine codes from `data-model.md` (FR-013)
- [X] T061 [P] Add a beta cross-reference to `docs/PRODUCTION.md` so the release runbook points at the promotion gate
- [X] T062 Run every scenario in `specs/007-beta-staging-environment/quickstart.md` (1–7), including the negative checks, and **record the measured bring-up, reset, and promotion times** in `docs/BETA.md` so SC-001, SC-007, and SC-008 have evidence rather than an assumption
- [X] T063 Run `npm run format` then `npm run format:check`
- [X] T064 Run `npm run lint`
- [X] T065 Run `npm test`
- [X] T066 Run `npm run build -w @video-compressor/agent` — the constitution notes CI never builds the agent, so this type check is carried manually

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**
- **US1 (Phase 3)**: depends on Foundational only
- **US2 (Phase 4)**: depends on Foundational only — independent of US1
- **US3 (Phase 5)**: depends on Foundational; **also depends on US1's beta profile wiring** (T026, T027) because the packaged build reuses the same environment values, and on US2's Guard B (T040) because promotion chains after `verify-release`
- **US4 (Phase 6)**: depends on Foundational only — independent of US1–US3
- **Polish (Phase 7)**: depends on all desired stories

### Shared-file serialization

Two files are written by tasks in more than one story. Because the Phase Dependencies above allow those stories to run concurrently, these edits MUST be serialized even though the tasks live in different phases:

- **`docs/BETA.md`** — T004 (Setup), T030, T031, T032 (US1), T053 (US3), T059 (US4), T060, T062 (Polish). One writer at a time. T004 keeps its `[P]` because Setup is a barrier that completes before any story begins, so it can never overlap the others; none of the story or polish tasks that write this file is marked `[P]`.
- **`apps/web/src/i18n.ts`** — deliberately consolidated into the single Foundational task T014 so no story reopens it. Do not add story-local translation tasks.

### Within Each User Story

- Tests are written first and must fail before implementation
- Shared module changes precede the consumers that import them
- Scripts precede the `package.json` entries that invoke them
- Documentation sections follow the behaviour they describe

### Parallel Opportunities

- **Setup**: T003 and T004 run in parallel
- **Foundational**: T009, T012, and T014 run in parallel; T005–T008 are the same file and must be sequential
- **US1**: T015 and T016 in parallel; then T020, T021, T022 in parallel; then T028 and T029 in parallel
- **US2**: T033 and T034 in parallel; then T035 and T037 in parallel
- **US4**: T055 and T056 in parallel
- **Across stories**: once Phase 2 is done, US1, US2, and US4 can proceed simultaneously; US3 waits on US1 and US2 as noted above

---

## Parallel Example: User Story 1

```bash
# Tests first, together:
Task: "Create tests/beta-isolation-guards.test.ts covering every Guard A row"
Task: "Create tests/beta-analytics.test.ts asserting beta emits nothing"

# Then the independent config surfaces, together:
Task: "Create scripts/verify-beta-env.mjs"
Task: "Add beta loopback redirect URLs to supabase/config.toml"
Task: "Document beta function values in supabase/functions/.env.example"

# Then the Drive-unavailable surfaces, together:
Task: "Mark Drive unavailable in apps/web/src/team/drive/DriveConnectionPanel.tsx"
Task: "Mark Drive unavailable in apps/web/src/team/create/ConnectFolderStep.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → 4. **Stop and validate**: run quickstart Scenario 1 end to end and confirm production analytics, production accounts, and real recipients are all untouched.

At that point the feature's core promise is already delivered: new features can be tested somewhere other than production.

### Incremental Delivery

1. Setup + Foundational → environment identity exists
2. **+ US1** → a working local mirror (**MVP**)
3. **+ US2** → beta is unmistakable and cannot leak into the release channel
4. **+ US3** → verified work promotes cleanly and unverified work is blocked
5. **+ US4** → resets make testing reproducible

US2 is P1 alongside US1 for a reason: a mirror that looks identical to production is a hazard, so ship it in the same pass rather than treating it as polish.

### Risk Notes

- **T023 is the task that closes the gap the analysis found.** Invitation mail does not travel through the platform's own transport at all — `supabase/functions/team-invitations/email.ts` posts straight to a third-party delivery API, so the local mail catcher never sees it and an unguarded beta would send real invitations to real people. This is the same class of failure as writing production analytics, and it is easy to miss precisely because every *other* message type is captured correctly.
- **T045 is the task most likely to be got wrong by pattern-matching.** `scripts/package-dev-mac.sh` sets `VITE_LOCAL_DEV_AUTH=true`; copying that line into the beta script would silently gut the feature by faking authentication. T048 guards against it in the artifact, and T015 guards against it in the profile.
- **T041 is the task most likely to be dropped.** Without the explicit exemption, Guard B fails on the very `supabase/config.toml` edit that T021 requires, and the fix under time pressure would be to weaken the guard rather than scope it.

---

## Notes

- `[P]` marks tasks in different files with no dependency on incomplete work
- `[Story]` labels map tasks to spec.md user stories for traceability
- Every task names an exact repository-relative path
- Commit after each task or logical group; stop at any checkpoint to validate a story independently

### Changes applied after `/speckit-analyze` (2026-08-20)

| Finding | Change |
|---|---|
| C1 CRITICAL — invitation mail reaches a real third-party provider | New task **T023**; `RESEND_API_KEY`/`INVITE_EMAIL_FROM` forced empty in T001 and T022; new code `BETA_DELIVERY_PROVIDER_FORBIDDEN` checked in T020 and asserted in T015 |
| D1 HIGH — shared rebuild missing on three scripts | Added to **T051** and **T058**, matching T027 |
| A1 MEDIUM — FR-002 carve-out stale after clarification | Fixed in `spec.md` FR-002 |
| F1 MEDIUM — `[P]` collision on `i18n.ts` across US1/US2 | All beta strings consolidated into the single Foundational task **T014** |
| F2 MEDIUM — `docs/BETA.md` written by three concurrent stories | New **Shared-file serialization** section; no doc task is `[P]` |
| C2 MEDIUM — source revision not reported at startup | Added to **T020** |
| C3 MEDIUM — promotion never reports divergence | Added to **T050** |
| C4 MEDIUM — loopback binding never asserted | Added to **T020** and **T048** |
| C5 LOW — production signing key never asserted against beta | Added to **T034** |
| B1 LOW — prerequisite probes untestable | T015 and T020 now specify injectable probes |
| D2 LOW — forbidden side-effect list incomplete | **T047** extended with migrations and Cloudflare |
| E1 LOW — timing criteria unmeasured | **T062** now records measured times |

### Implementation status (2026-08-20)

**All 66 tasks complete.** Verified against a live environment after installing the missing
prerequisites (Node 22, FFmpeg, Supabase CLI, colima) on the development machine.

#### Verified live, not only in tests

| Scenario | Result |
|---|---|
| Bring-up (`beta:up`) | Agent on 43140 reports `"environment": "beta"`, `"ready": true`; web serves 200 on 5175 |
| Loopback only (FR-009a) | `lsof` shows both processes bound to `127.0.0.1`, never `0.0.0.0` |
| Local stack | All 42 migrations applied clean on `supabase start` and again on every reset |
| Reset + fixtures | Baseline restored in ~35 s; `beta@soty.local` / "Beta Workspace" / admin role queried back out of the database |
| Reset guard | A remote `SUPABASE_DB_URL` refused with `BETA_RESET_TARGET_UNSAFE` before any write |
| Guard A | Real doctor run with production and delivery-credential overrides; each failed with its own code, subject, and remedy |
| Guard B | A **real** beta bundle placed in `apps/web/dist` was rejected: `RELEASE_BETA_CONFIG … contains the beta marker "127.0.0.1:43140"` |
| Beta bundle identity | Contains the BETA/БЕТА badge strings and points at `127.0.0.1:43140` / `127.0.0.1:54321`, not production |
| Shutdown | Both ports released, local stack stopped, 14 s |
| Constitution gates | `format:check` clean, `lint` clean, `verify-release.mjs` green, agent build clean |
| Full suite on Node 22 | 1077 passed, 1 failed (pre-existing, see below) |

#### Two bugs the live run found, both fixed

1. `supabase db execute --file` does not exist in CLI 2.115 — the reset failed at the seeding step
   (loudly, and after the database was already migrated, exactly as designed).
2. `supabase db query --file` uses a prepared statement and rejects a multi-statement file. Seeding
   now goes through the `pg` client, already a root dependency, so no prerequisite was added.

#### Known failures that are not this feature's

- `tests/local-app-dialog.test.tsx` — one test, from the Windows work committed as `16176f1` by a
  concurrent session. Confirmed pre-existing by stashing this feature's changes and re-running.
- `release/dmg-stage/.../rendered-html.test.mjs` — a stray test inside a copy of `ChatGPT.app` that
  ended up in the DMG staging directory. Vitest scans `release/` because it does not read
  `.gitignore`. Deleting `release/dmg-stage` removes it.

#### Measured timings

Recorded in `docs/BETA.md`: first bring-up including installs ~9 min (target 15), subsequent bring-up
34 s (target 5 min), reset ~35 s (target 5 min), shutdown 14 s.
