# Implementation Plan: Beta Staging Environment

**Branch**: `007-beta-staging-environment` | **Date**: 2026-08-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-beta-staging-environment/spec.md`

## Summary

Give the maintainer a production-equivalent mirror of Soty that runs entirely on their own machine, backed by the repository's existing local Supabase stack, so new features are exercised end-to-end before they reach production.

The approach exploits a fact the codebase already provides: **the agent and web app are almost entirely environment-driven already.** The agent reads `AGENT_PORT`, `PUBLIC_SITE_ORIGIN`, `DEV_SITE_ORIGIN`, `AGENT_SUPPORT_DIRECTORY_NAME`, and `AGENT_ENTITLEMENT_PUBLIC_KEY` from the environment (`apps/agent/src/config.ts`, `apps/agent/src/files/support-dir.ts`); the web app validates its config through one function (`apps/web/src/lib/config.ts`) and already honours `VITE_ANALYTICS_ENABLED`; `scripts/package-dev-mac.sh` already proves a second, port-isolated, separately-branded macOS app can be built from this tree. Beta is therefore not a new architecture — it is **a third environment profile plus the guards that keep it from touching production.**

Three things are genuinely new work rather than configuration:

1. **A first-class environment identity.** A `VITE_APP_ENVIRONMENT` / `SOTY_ENVIRONMENT` value (`production` | `beta`), defined as a typed union in `@video-compressor/shared`, that drives the badge, disables analytics *structurally* rather than by flag, permits loopback origins that a production build must reject, and is the thing every guard keys on.
2. **Bidirectional isolation guards.** Beta refuses to start against a production endpoint; production refuses to release with any beta marker present. Both are hard failures with named reasons, in the style of the existing `verify-*.mjs` gates.
3. **Containment of every outbound path, not just the obvious one.** Telemetry and identity are the paths one thinks of first, but `supabase/functions/team-invitations/email.ts` posts straight to a third-party delivery API, so invitation mail never passes through the local capture sink at all. Beta configures no delivery-provider credential and surfaces invitation links locally instead of sending them.
4. **Real local auth and real entitlement.** The existing dev package sets `VITE_LOCAL_DEV_AUTH=true`, which fakes a hardcoded user and bypasses Supabase entirely — that is exactly what beta must *not* do. Beta signs in for real against the local Supabase stack and enforces the entitlement gate with a beta-only keypair, so pairing, tokens, and account gating are genuinely exercised.

## Technical Context

**Language/Version**: TypeScript 5.9, `strict: true`, ESM `NodeNext`, target ES2022. Node 22 runtime. Orchestration scripts in `.mjs`; macOS packaging in zsh.

**Primary Dependencies**: Fastify 5 (agent), React 19 + Vite 8 (web), `@supabase/supabase-js` 2 (web + edge functions), Supabase CLI (local stack), Docker Desktop or an equivalent container runtime (required by `supabase start`), FFmpeg/whisper runtimes already staged for development.

**Storage**: Local Supabase stack from the in-repo `supabase/` directory — Postgres 17, GoTrue auth, Deno edge functions, and the local mail catcher. 42 existing migrations and 10 edge functions apply unchanged. Agent-side state lives under a beta-specific Application Support directory.

**Testing**: Vitest, central `tests/` directory, `*.test.ts(x)`. New suites cover the environment union and its guards (pure functions, node env), the web badge and config validation (jsdom), and the release-gate rejections. Packaged-beta verification is a zsh smoke script in the style of `scripts/verify-dev-package.sh`.

**Target Platform**: macOS arm64 first (matching the current packaged product); the run-from-source mode is platform-neutral and the packaged path follows the Windows rollout of feature 006 once that lands.

**Project Type**: Monorepo — local Fastify agent + React web app + shared contract package + Node/zsh tooling. This feature adds an environment profile and tooling; it introduces no new application.

**Performance Goals**: First-ever beta bring-up under 15 minutes including container image pulls; subsequent bring-up under 5 minutes (SC-001). Reset to a fixture-seeded baseline under 5 minutes (SC-007).

**Constraints**: Loopback only — beta never binds an externally reachable address (FR-009a). Beta, production, and an ordinary dev run must coexist on one machine, so ports, Application Support directories, instance locks, and bundle identifiers must all be distinct (FR-007). No beta endpoint, key, or switch value in any file that feeds a production build or deploy (FR-008, SC-012). Beta must be fully usable with zero third-party registrations (FR-027, SC-002a).

**Scale/Scope**: Single maintainer, one machine, one concurrent beta instance. Roughly 8 new scripts, 1 new shared module, 1 new web component, small additive changes to `apps/agent/src/config.ts`, `apps/web/src/lib/config.ts`, the analytics service, and three existing verification gates.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| Principle | Gate | Verdict |
|---|---|---|
| **I. Type-Safe Contracts, Validated at the Boundary** | The environment value is a string-literal union in `@video-compressor/shared`, parsed from `unknown` env input through a discriminated-union result rather than cast; ports and origins reuse existing validators. | **PASS** — `AppEnvironment = 'production' \| 'beta'` with `parseAppEnvironment(value: unknown): { ok: true; value } \| { ok: false; error }`, mirroring the existing `ConfigResult` idiom in `apps/web/src/lib/config.ts`. No new magic constants: beta ports and names are declared once in shared and read everywhere else. |
| **II. One Source of Truth for the Release & Protocol Contract** | Beta must not fork `packages/shared/src/release.ts`, must not write `stable.json`, must not create tags, and every script reading the contract must rebuild `shared` first. | **PASS** — the beta version string is *derived at packaging time* from `PRODUCT_VERSION` (`1.0.0-beta.<sha>[.dirty].<stamp>`), exactly as `scripts/package-dev-mac.sh` already derives its dev version. `beta:package` is gated to refuse if it would modify `release.ts`, `stable.json`, `config/production.env`, or any git tag. Every beta script begins with `npm run build -w @video-compressor/shared`. |
| **III. Security and Least Privilege by Construction** | Isolation must be structural, not conventional; no secret in a tracked file; the reset must be incapable of reaching production. | **PASS** — analytics in beta is disabled in code (`environment !== 'beta'`), not only by `VITE_ANALYTICS_ENABLED`, so flipping the flag cannot re-enable it. Beta entitlement uses a **separate** keypair under the already-gitignored `config/keys/`, so a beta token is cryptographically invalid in production and vice versa. `beta:reset` refuses any database URL that is not loopback. `.env.beta` is already covered by the existing `.env.*` gitignore rule. |
| **IV. Disciplined Child-Process & Resource Orchestration** | Beta orchestration spawns the Supabase CLI, Vite, and the agent; it must use `spawn(..., { shell: false })`, bounded output, and clean shutdown. | **PASS** — `beta:up` / `beta:down` spawn with argument arrays and no shell, track child PIDs, and escalate SIGTERM → SIGKILL on shutdown with `.unref()`'d timers, matching the agent's existing orchestration discipline. |
| **V. Consistent HTTP API & Error Conventions** | The one API change is additive and must use machine codes. | **PASS** — `/api/health` gains an `environment` field on the existing snapshot; the beta startup guard fails before the server binds, so no new status code is introduced. Guard failures use stable machine codes (`BETA_PRODUCTION_ENDPOINT`, `BETA_ENV_MISSING`, `BETA_PORT_IN_USE`). |
| **VI. Frontend Composition & State Discipline** | The badge must be a small functional component using `className` against `styles.css` and compile-checked i18n keys, not a new pattern. | **PASS** — one `EnvironmentBadge.tsx` rendered from `Root.tsx`, reading the environment from the existing config module; new strings added to the `TranslationKey` union in `apps/web/src/i18n.ts`. No new global store, no new fetch path. |

**Result: all gates pass.** One deviation requires justification and is recorded in Complexity Tracking below.

### Post-design re-evaluation (after Phase 1)

Re-checked against the artifacts actually produced. No gate changed verdict, and the design tightened
three of them:

- **Principle I** strengthened rather than merely satisfied: `EnvironmentProfile` in
  `data-model.md` declares the beta port, bundle id, support directory, and lock name **once** in
  shared, and `tests/beta-environment.test.ts` asserts they are pairwise distinct from the production
  and dev profiles — so a future fourth profile cannot silently reuse a slot.
- **Principle III** strengthened: analytics suppression and entitlement separation both became
  structural (code-level condition, separate keypair) rather than configuration-level, so neither can
  be undone by a bad env file.
- **Principle II** re-verified against the design's one risk — that beta packaging might fork release
  identity. It does not: the beta version is derived from `PRODUCT_VERSION` at packaging time, and
  `beta:package` is gated to refuse if any production-identity file or git tag would change.

The single deviation (beta redirect URLs in the tracked `supabase/config.toml`) is unchanged and is
now bounded in code as well as in prose: `contracts/beta-guard-contract.md` names the exact
production-feeding file set the guard scans and records the exemption explicitly, and
`tests/beta-release-gates.test.ts` asserts the exemption holds — so the scope cannot widen or produce
a false failure by accident.

## Project Structure

### Documentation (this feature)

```text
specs/007-beta-staging-environment/
├── plan.md              # This file
├── research.md          # Phase 0 output — decisions with rationale and rejected alternatives
├── data-model.md        # Phase 1 output — environment profile, fixtures, verification record
├── quickstart.md        # Phase 1 output — runnable validation scenarios
├── contracts/
│   ├── beta-environment-contract.md   # env variable contract, ports, names, precedence
│   ├── beta-cli-contract.md           # npm script surface and exit-code behaviour
│   └── beta-guard-contract.md         # isolation guards and release-gate rejections
├── checklists/
│   └── requirements.md
├── spec.md
└── tasks.md             # Phase 2 output — created by /speckit-tasks, NOT by this command
```

### Source Code (repository root)

```text
packages/shared/src/
├── environment.ts                 # NEW — AppEnvironment union, parser, beta port/name constants,
│                                  #       production-endpoint detection used by every guard
└── index.ts                       # export the new module

apps/agent/src/
├── config.ts                      # environment field + beta isolation assertion at startup
└── server/app.ts                  # additive `environment` on the /api/health snapshot

apps/web/src/
├── lib/config.ts                  # environment-aware validation: loopback origins legal only in beta
├── analytics/service.ts           # structural disable when environment is beta
├── release-manifest.ts            # beta does not query the production update manifest
├── components/EnvironmentBadge.tsx# NEW — persistent beta indicator
├── Root.tsx                       # render the badge
└── i18n.ts                        # beta badge and beta about-surface strings

scripts/
├── verify-beta-env.mjs            # NEW — prerequisite + isolation doctor (FR-006, FR-010, FR-011)
├── beta-up.mjs                    # NEW — single-command bring-up (FR-009)
├── beta-down.mjs                  # NEW — single-command clean shutdown (FR-012)
├── beta-reset.mjs                 # NEW — reset to baseline + fixtures (FR-024..FR-026)
├── package-beta-mac.sh            # NEW — packaged beta build (FR-002a)
├── verify-beta-package.sh         # NEW — packaged beta identity/isolation smoke (FR-002b)
├── verify-beta-promotion.mjs      # NEW — HEAD contained in beta + verification record (FR-020a, SC-011)
├── generate-signing-keys.mjs      # extend with beta entitlement keypair target
├── verify-release.mjs             # reject beta identity and beta configuration (FR-017, FR-021)
└── verify-published-release.mjs   # assert no beta artifact in the update channel (FR-018)

supabase/
├── config.toml                    # add beta loopback redirect URLs (local stack only)
├── functions/.env.example         # document beta values; delivery-provider keys empty in beta
└── fixtures/beta-seed.sql         # NEW — representative account, workspace, media fixture

supabase/functions/team-invitations/
├── index.ts                       # surface the invitation link locally when no delivery provider is set
└── email.ts                       # do not reach the third-party delivery API in beta

tests/
├── beta-environment.test.ts       # NEW — union parsing, precedence, port/name distinctness
├── beta-isolation-guards.test.ts  # NEW — beta refuses production endpoints and delivery providers
├── beta-analytics.test.ts         # NEW — beta emits no telemetry even with the flag on
├── beta-release-gates.test.ts     # NEW — release gate rejects beta identity and beta config
├── beta-promotion-gate.test.ts    # NEW — promotion refuses uncontained or stale-record commits
├── beta-reset-guard.test.ts       # NEW — reset refuses a non-loopback target before any write
└── beta-web-environment.test.tsx  # NEW — badge renders in beta, absent in production

docs/BETA.md                       # NEW — prerequisites, start, stop, reset, promotion, troubleshooting
.env.beta.example                  # NEW — committed placeholder template (FR-008a)
```

**Structure Decision**: No new application or package. The feature lands as one new shared module, additive changes to the existing agent config / web config / analytics / release-manifest seams, one new web component, a family of `scripts/` entry points following the established `.mjs` (contract-reading, cross-platform) and zsh (macOS packaging) split, and one new docs page. This keeps beta inside the seams the constitution already defines rather than creating a parallel structure.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Beta loopback redirect URLs (`http://127.0.0.1:5175`, `http://127.0.0.1:43140`) added to the **tracked** `supabase/config.toml`, which is in tension with FR-008's "no beta value in a tracked file" | The Supabase CLI reads auth redirect allowlists only from `config.toml`; without the entries, real sign-in against the local stack — the whole point of the beta environment — cannot complete. | A second config file was rejected because the CLI supports exactly one. Templating `config.toml` at bring-up was rejected because it would make a tracked file dirty on every run and could silently diverge. The tension is resolved by **scoping FR-008 precisely**: the prohibition covers files that feed a production build or deploy (`.env`, `apps/web/.env.production`, `config/production.env`, `packages/shared/src/release.ts`, `stable.json`, `packaging/*`). `supabase/config.toml` governs only the locally-run stack and is never read by the hosted project, so it is explicitly exempt — and `verify-release.mjs` enforces the prohibition on the production-feeding list, not on this file. |
