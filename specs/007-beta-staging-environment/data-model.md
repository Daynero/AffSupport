# Phase 1 Data Model: Beta Staging Environment

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md)

This feature is infrastructural: its "data" is the set of typed values that define an environment,
the on-disk state that belongs to it, and the fixtures and records that make it reproducible. No
production database schema changes.

---

## 1. `AppEnvironment` (shared contract)

**Module**: `packages/shared/src/environment.ts` · **Consumed by**: web config, agent config, every guard script

```
AppEnvironment = 'production' | 'beta'
```

| Field | Type | Rules |
|---|---|---|
| value | `AppEnvironment` | String-literal union. Exhaustive switches only; no default branch that swallows an unknown value. |

**Parser** — the single boundary crossing, following the existing `ConfigResult` idiom:

```
parseAppEnvironment(value: unknown): { ok: true; value: AppEnvironment } | { ok: false; error: string }
```

**Validation rules**

- `undefined`, `null`, or empty → `production`. Absence must never yield beta (research R2).
- Any string not in the union → `{ ok: false }` with the offending value named. Never coerced.
- Comparison is exact and case-sensitive; `'Beta'` is an error, not a match.

**Environment variable surface**

| Process | Variable | Default |
|---|---|---|
| Web build (Vite) | `VITE_APP_ENVIRONMENT` | `production` |
| Agent process | `SOTY_ENVIRONMENT` | `production` |

---

## 2. `EnvironmentProfile` (derived, not stored)

The complete set of values that distinguish one running copy from another. Declared once in
`packages/shared/src/environment.ts` so no script re-derives a port or a directory name.

| Field | Production | Beta | Rule |
|---|---|---|---|
| `environment` | `production` | `beta` | — |
| `agentPort` | 43120 | **43140** | 1024–65535; must differ from every other profile and from Soty Dev's 43130 |
| `webPort` | n/a (hosted) | **5175** | must differ from the ordinary dev server's 5173 |
| `siteOrigin` | `https://soty.pp.ua` | **`http://127.0.0.1:5175`** (source) / **`http://127.0.0.1:43140`** (packaged) | beta values must be loopback; production must be HTTPS |
| `appName` | `Soty` | **`Soty Beta`** | — |
| `bundleId` | `com.wishly` | **`com.wishly.beta`** | must be unique per profile |
| `supportDirectoryName` | `Soty` | **`Soty Beta`** | feeds `AGENT_SUPPORT_DIRECTORY_NAME` |
| `instanceLockName` | `wishly-agent.lock` | **`wishly-beta-agent.lock`** | prevents two instances of the same profile |
| `releaseChannel` | `stable` | **`beta`** | — |
| `analyticsEnabled` | configurable | **always false** | not overridable by env (research R5) |
| `entitlementEnforced` | true, production key | **true, beta key** | keys must be different keypairs |

**Invariant** (test-enforced in `tests/beta-environment.test.ts`): across production, ordinary dev,
and beta, the values of `agentPort`, `bundleId`, `supportDirectoryName`, and `instanceLockName` are
pairwise distinct. A future fourth profile cannot silently reuse a slot.

---

## 3. `BetaConfigFile` (on disk, git-ignored)

**Path**: `.env.beta` at repository root · **Template**: `.env.beta.example` (committed, placeholders only)

Loaded by Vite in `--mode beta` (the web app's `envDir` is the repository root) and read by the beta
scripts. Already covered by the existing `.env.*` gitignore rule; the template needs an explicit
`!.env.beta.example` negation.

| Key | Required | Constraint |
|---|---|---|
| `VITE_APP_ENVIRONMENT` | yes | must be exactly `beta` |
| `VITE_SUPABASE_URL` | yes | loopback only; rejected if it resolves to a non-local host |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | yes | local anon key; rejected if secret/service_role (existing check) |
| `VITE_SITE_URL` | yes | loopback only |
| `VITE_AGENT_URL` | yes | `http://127.0.0.1:43140` |
| `VITE_ANALYTICS_ENABLED` | yes | must be `false`; suppression is structural regardless |
| `VITE_LOCAL_DEV_AUTH` | yes | must be `false` — beta uses real auth (research R3) |
| `SOTY_ENVIRONMENT` | yes | `beta` |
| `AGENT_PORT` | yes | `43140` |
| `PUBLIC_SITE_ORIGIN` | yes | loopback only |
| `AGENT_SUPPORT_DIRECTORY_NAME` | yes | `Soty Beta` |
| `AGENT_ENTITLEMENT_PUBLIC_KEY` | yes | beta public key; must differ from the production key |
| `RESEND_API_KEY` | yes | must be empty — a delivery-provider credential is forbidden in beta |
| `INVITE_EMAIL_FROM` | yes | must be empty for the same reason |

**State transitions**: absent → created from template by the maintainer → validated by
`verify-beta-env.mjs` on every bring-up. Validation is a gate, not a warning: an invalid profile
prevents startup with a named reason.

---

## 4. `BetaFixtures` (seed data)

**Path**: `supabase/fixtures/beta-seed.sql` · Applied after `supabase db reset`, never as a shared seed.

| Entity | Purpose | Notes |
|---|---|---|
| Beta account | A confirmed, active user to sign in as | Deterministic id and address (`beta@soty.local`); `profiles.account_status = 'active'` so the entitlement path succeeds |
| Team workspace | Owned by the beta account | Enough to exercise workspace, library, and landing flows |
| Sample media item | A small file reference | Lets an end-to-end journey start without first sourcing content |

**Rule**: fixtures use fixed identifiers so a reset is reproducible and assertions can name them.
They contain no copy of production data.

---

## 5. `BetaVerificationRecord`

**Path**: `release/beta/verification.json` (inside the already-gitignored `release/`) · Written by
`verify-beta-package.sh` on success, read by `verify-beta-promotion.mjs`.

| Field | Type | Rule |
|---|---|---|
| `sourceRevision` | string | Full commit SHA of the tree the packaged beta was built from |
| `buildId` | string | `<PRODUCT_VERSION>-beta.<sha>[.dirty].<stamp>+<buildNumber>` |
| `verifiedAt` | ISO-8601 string | Written only after the packaged smoke passes |
| `dirty` | boolean | True if the worktree had uncommitted changes at build time |

**Promotion rule** (FR-020a, SC-011): a production package or deploy is refused unless a record
exists whose `sourceRevision` equals the release commit and whose `dirty` is `false`, and unless that
commit is contained in the `beta` branch. A record from a different revision does not satisfy the
gate, so a stale pass cannot be reused.

---

## 6. Agent health snapshot (additive API change)

`/api/health` gains one field on the existing snapshot; the shape is otherwise unchanged, so older
clients are unaffected.

| Field | Type | Meaning |
|---|---|---|
| `environment` | `AppEnvironment` | Which profile this agent process belongs to |

Used by diagnostics and by the packaged-beta smoke to prove a beta agent is not a production agent.

---

## 7. Guard error codes

Stable machine codes, per Constitution Principle V — clients and scripts branch on these, never on
prose.

| Code | Raised by | Meaning |
|---|---|---|
| `BETA_ENV_MISSING` | `verify-beta-env.mjs` | `.env.beta` absent or a required key is unset |
| `BETA_PRODUCTION_ENDPOINT` | beta env guard, agent startup | A production URL, origin, or key is configured in beta |
| `BETA_LOCAL_AUTH_FORBIDDEN` | beta env guard, packaged smoke | `VITE_LOCAL_DEV_AUTH=true` would fake authentication |
| `BETA_DELIVERY_PROVIDER_FORBIDDEN` | `verify-beta-env.mjs` | A third-party message-delivery credential is configured in beta |
| `BETA_PORT_IN_USE` | `verify-beta-env.mjs` | A required beta port is already held |
| `BETA_PREREQUISITE_MISSING` | `verify-beta-env.mjs` | Container runtime, Supabase CLI, or media tooling unavailable |
| `BETA_RESET_TARGET_UNSAFE` | `beta-reset.mjs` | The reset target is not a loopback database |
| `RELEASE_BETA_IDENTITY` | `verify-release.mjs` | The artifact carries a beta identity |
| `RELEASE_BETA_CONFIG` | `verify-release.mjs` | A beta value is present in a production-feeding file or in `dist` |
| `RELEASE_BETA_UNVERIFIED` | `verify-beta-promotion.mjs` | HEAD is not contained in `beta`, or no matching verification record exists |
