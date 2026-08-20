# Phase 0 Research: Beta Staging Environment

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-08-20

The clarification session settled *what* beta must be. This document settles *how*, against what the
repository actually contains. Every decision below was checked against real code, not assumed.

---

## R1 — Backing stack for beta data and identity

**Decision**: Use the repository's existing local Supabase stack (`supabase start`) as the beta
database, auth provider, and edge-function host. No new schema, no second project.

**Rationale**: `supabase/` already contains `config.toml`, 42 forward-only migrations, and 10 edge
functions. `supabase start` therefore reproduces the production schema and server-side logic exactly,
on the maintainer's machine, at zero cost. Two secondary benefits matter as much as the primary one:
every beta bring-up re-applies the migration chain, so a broken migration is caught before release
rather than during a production deploy; and production credentials simply do not exist in the
environment, which makes the isolation structural rather than a matter of care.

**Alternatives considered**:
- *A separate hosted beta Supabase project* — rejected. It is a second live project to keep
  migrated, secured, and paid for, and it reintroduces the exact failure mode this feature exists to
  remove: a real credential that could be pointed at the wrong project.
- *The production project with a beta schema or tenant flag* — rejected outright. It puts beta data
  one policy mistake away from production data and makes FR-025 (a reset that cannot touch
  production) impossible to guarantee.

**Consequences**: A container runtime becomes a hard prerequisite, checked by name at bring-up.
Default local ports (API 54321, DB 54322, Studio 54323, mail catcher 54324) are documented and
port-checked.

---

## R2 — How beta is identified at runtime

**Decision**: Introduce a typed environment identity in `@video-compressor/shared`:
`AppEnvironment = 'production' | 'beta'`, surfaced as `VITE_APP_ENVIRONMENT` in the web build and
`SOTY_ENVIRONMENT` in the agent process, defaulting to `production` when absent.

**Rationale**: Beta needs one value that many behaviours key on — the badge (FR-014), the analytics
kill (FR-005), permission to use loopback origins (FR-006), skipping the production update manifest
(FR-018), and every guard. Deriving that from a scatter of independent booleans would let the
behaviours drift apart, which is precisely how a half-beta build gets created. A single string-literal
union parsed once at the boundary matches Constitution Principle I, and `apps/web/src/lib/config.ts`
already establishes the `{ ok: true; value } | { ok: false; errors }` idiom to copy.

**Defaulting to `production` is deliberate**: an unset or malformed value must never silently produce
a beta build. The failure direction is chosen so that a mistake yields a *stricter* environment, and
the beta scripts assert the value explicitly rather than relying on the default.

**Alternatives considered**:
- *Reuse Vite's `import.meta.env.MODE === 'beta'`* — rejected. It exists only in the web bundle, so
  the agent and the `.mjs` gates could not read the same fact, and it is a build-tool detail rather
  than a product contract.
- *Infer beta from the port or the site origin* — rejected as fragile and implicit; a guard that
  infers cannot produce the named failure reasons FR-006 requires.

---

## R3 — Real authentication versus the existing dev shortcut

**Decision**: Beta sets `VITE_LOCAL_DEV_AUTH=false` and authenticates for real against local Supabase
auth, with outbound mail captured by the local mail catcher.

**Rationale**: This is the sharpest divergence from the existing `scripts/package-dev-mac.sh`, which
sets `VITE_LOCAL_DEV_AUTH=true`. Reading `apps/web/src/auth/AuthContext.tsx` shows what that flag
does: it substitutes a hardcoded user (`dev@wishly.local`, a fixed UUID) and short-circuits both the
session-restore effect and `signInWithGoogle`. An environment carrying that flag cannot test sign-in,
session expiry, profile creation, account status, or anything downstream of a real identity — which
would gut FR-002. Soty Dev is a *tool for working on the app*; beta is a *mirror for verifying it*,
and the two need opposite settings here.

**Consequence**: `verify-beta-env.mjs` asserts `VITE_LOCAL_DEV_AUTH` is not `true` in the beta
profile, and the packaged-beta smoke asserts the same of the built bundle. This is the one place
where copying the dev script would quietly defeat the feature, so it is guarded rather than
documented.

---

## R4 — Entitlement and agent tokens in beta

**Decision**: Generate a **beta-only** entitlement keypair into the already-gitignored `config/keys/`.
The local `issue-agent-token` function signs with the beta private key
(`supabase/functions/.env.local`, already gitignored); the packaged beta app embeds the beta public
key, so the entitlement gate is genuinely **enforced** in beta.

**Rationale**: `apps/agent/src/entitlement/entitlement.ts` documents that enforcement is
packaging-driven — with no `AGENT_ENTITLEMENT_PUBLIC_KEY` the gate reports everything as entitled,
which is what Soty Dev does today. Leaving beta unenforced would mean pairing, token expiry, the
offline grace window, and account-status blocking are never exercised outside production. Using a
distinct keypair also delivers FR-027b for free and in the strongest possible form: a
production-issued token fails signature verification in beta and a beta-issued token fails in
production, cryptographically, with no configuration to get wrong.

**Alternatives considered**:
- *Empty key, as Soty Dev does* — rejected: leaves a whole gate untested.
- *Reuse the production entitlement key* — rejected: it would make beta and production tokens
  interchangeable, directly violating FR-027b, and would require a production private key on the
  development machine.

---

## R5 — Structural analytics suppression

**Decision**: Suppress analytics in beta in code — effectively `enabled = ANALYTICS_ENABLED &&
environment !== 'beta'` — in addition to shipping `VITE_ANALYTICS_ENABLED=false` in the beta profile.

**Rationale**: `apps/web/src/analytics/service.ts` reads `VITE_ANALYTICS_ENABLED !== 'false'`, so
today a single mistyped or missing flag re-enables telemetry. SC-003 demands *zero* production
analytics events from beta activity, and Principle III demands isolation by construction. Making the
environment an independent, non-overridable condition means the guarantee survives a bad env file.
Belt and braces is justified here because the failure is silent and the damage — polluted product
metrics — is discovered late.

---

## R6 — Coexistence: ports, directories, identifiers

**Decision**: Beta occupies its own slot across every namespace that could collide:

| Resource | Production | Ordinary dev | **Beta** |
|---|---|---|---|
| Agent port | 43120 | 43130 (Soty Dev) | **43140** |
| Web dev server | — | 5173 | **5175** |
| App name / bundle id | Soty / `com.wishly` | Soty Dev / `com.wishly.dev` | **Soty Beta / `com.wishly.beta`** |
| Application Support dir | `Soty` | `Soty Dev` | **`Soty Beta`** |
| Instance lock | `wishly-agent.lock` | `wishly-dev-agent.lock` | **`wishly-beta-agent.lock`** |
| Release channel | `stable` | `development` | **`beta`** |

**Rationale**: FR-007 and SC-010 require all three to run at once. The mechanisms already exist and
are proven: `AGENT_PORT` and `AGENT_SUPPORT_DIRECTORY_NAME` are read in `apps/agent/src/config.ts`
and `apps/agent/src/files/support-dir.ts`, and `scripts/render-launcher.mjs` already parameterises
app name, bundle id, lock name, and support directory — `package-dev-mac.sh` demonstrates the whole
set working together. Beta adds a third row to a table that already has two.

**Consequence**: `http://127.0.0.1:5175` and `http://127.0.0.1:43140` must join
`additional_redirect_urls` in `supabase/config.toml` for real sign-in to complete. That tracked-file
edit is the one deviation recorded in the plan's Complexity Tracking, with its scope justification.

---

## R7 — Bidirectional isolation guards

**Decision**: Two guards that fail loudly with named reasons, in the style of the existing
`verify-*.mjs` family.

- **Beta refuses production** (FR-006): `verify-beta-env.mjs` and an assertion in
  `apps/agent/src/config.ts` reject any Supabase URL, site origin, or agent origin that is not
  loopback, and reject any value equal to `PRODUCTION_SITE_ORIGIN`. Machine codes:
  `BETA_PRODUCTION_ENDPOINT`, `BETA_ENV_MISSING`, `BETA_PORT_IN_USE`, `BETA_LOCAL_AUTH_FORBIDDEN`.
- **Production refuses beta** (FR-017, FR-021, SC-012): `verify-release.mjs` gains checks that no
  beta marker (`VITE_APP_ENVIRONMENT=beta`, `com.wishly.beta`, the beta port, channel `beta`) appears
  in the production-feeding file set or in the built `apps/web/dist`, and that the release channel and
  version carry no beta identity.

**Rationale**: The high-consequence failures of this feature are all leakage, in both directions, and
both are silent by nature. `scripts/verify-dev-package.sh` already sets the precedent of asserting
build-time flags by inspecting the artifact, and `verify-release.mjs` is already the mandatory gate in
front of every package and deploy — extending it is cheaper and far more reliable than adding a new
gate someone must remember to run.

---

## R8 — Promotion and branch topology

**Decision**: `beta` is a long-lived integration branch; feature work merges into `beta`, and `main`
receives work only by merge from `beta`. `verify-beta-promotion.mjs` asserts that the release commit
is contained in `beta` (`git merge-base --is-ancestor HEAD beta`) and that a beta verification record
exists whose `sourceRevision` equals the release commit. The check is chained into `package:mac` and
`deploy:web` alongside the existing gates.

**Rationale**: FR-020a and SC-011 require that nothing reaches production without beta verification,
and the existing release chain already demonstrates the pattern — `deploy:web` chains
`verify-web-env` → `build:web` → `verify-release --deploy` → `verify-published-release`. Adding one
more link keeps the guarantee in the place that already cannot be bypassed. Containment in `beta` is
checked with git itself rather than trusted from a note, and the verification record ties the
*packaged* beta smoke (FR-002b) to a specific revision so a stale pass cannot be reused.

**Alternatives considered**:
- *Branch protection or CI enforcement* — rejected for now. The constitution records that the only
  workflow is `workflow_dispatch`-only and nothing runs on push or PR, so a CI-based guarantee would
  be aspirational. A local gate in the existing chain is real today; CI enforcement is a later,
  separate improvement.

---

## R9 — Reset and fixtures

**Decision**: `beta:reset` runs `supabase db reset` (which re-applies all migrations), then applies
`supabase/fixtures/beta-seed.sql` explicitly, then clears the `Soty Beta` Application Support
directory. It refuses to run against any database URL that is not loopback.

**Rationale**: `supabase db reset` is the supported, well-understood path and re-exercises the
migration chain as a side effect. Applying fixtures as a separate explicit step rather than as
`config.toml`'s seed keeps ordinary development unaffected — a shared seed would change behaviour for
anyone running the local stack for other reasons. Clearing the support directory matters because the
agent's queue state, caches, and entitlement state live on disk, not in the database; a reset that
left them behind would produce a confusingly half-clean environment.

**Fixtures**: one confirmed beta account, one team workspace owned by it, and one small sample media
item — the minimum needed to start an end-to-end journey immediately (FR-026).

---

## R10 — External-storage (Drive) connection

**Decision**: Ship beta with `DRIVE_OAUTH_MODE=disabled` in the local function environment. Drive
becomes available only after a documented one-time setup of a maintainer-owned Google test client,
switching the local mode to `testing`. Until then, Drive-dependent surfaces are visibly marked
unavailable in beta.

**Rationale**: `supabase/functions/.env.example` already ships `DRIVE_OAUTH_MODE=disabled` with the
comment that it must fail closed unless a developer explicitly opts into an isolated testing flow,
and already documents the loopback callback
(`http://127.0.0.1:54321/functions/v1/drive-oauth-callback`). The mechanism exists; the feature's job
is to make the opt-in documented and the unavailable state honest rather than a confusing failure.
This is what makes SC-002a achievable — beta works with no third-party account at all.

---

## R11 — Update channel isolation

**Decision**: In beta, the web app does not fetch the production release manifest, and the beta
packaging script is forbidden from writing `stable.json`, creating tags, or touching
`packages/shared/src/release.ts`.

**Rationale**: `apps/web/src/release-manifest.ts` derives `RELEASE_MANIFEST_URL` from
`PRODUCTION_SITE_ORIGIN`, so an unmodified beta build would query the production update channel and
could offer a production download to a beta install. FR-018 requires the reverse direction too — a
beta artifact must never appear in the channel — which is guaranteed by construction as long as beta
never writes the signed manifest. The beta artifact is also not signed with the release-manifest key
(FR-016a); that key stays reserved for `stable.json`.

---

## Resolved unknowns

No `NEEDS CLARIFICATION` markers remain from Technical Context. The three decisions the spec
checklist had deferred (backing stack, reachability, packaging) were settled in the 2026-08-20
clarification session and are elaborated above in R1, R6, and the plan's dual-run-mode design.
