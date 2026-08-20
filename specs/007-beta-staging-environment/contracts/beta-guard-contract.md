# Contract: Isolation Guards

**Status**: Design · **Feature**: [../spec.md](../spec.md)

Two guards, pointing in opposite directions. Both fail closed, both name the offending value, and
both use the stable machine codes listed in [../data-model.md](../data-model.md).

---

## Guard A — beta must not reach production

**Enforced by**: `scripts/verify-beta-env.mjs` (before bring-up), an assertion in
`apps/agent/src/config.ts` (before the server binds), and `apps/web/src/lib/config.ts` (at config
validation).

When the environment is `beta`, every one of these is a hard failure:

| Condition | Code |
|---|---|
| Supabase URL, site URL, agent URL, or public origin is not loopback | `BETA_PRODUCTION_ENDPOINT` |
| Any configured origin equals `PRODUCTION_SITE_ORIGIN` | `BETA_PRODUCTION_ENDPOINT` |
| `AGENT_ENTITLEMENT_PUBLIC_KEY` is empty, or equals the production key | `BETA_PRODUCTION_ENDPOINT` |
| `VITE_LOCAL_DEV_AUTH` is `true` | `BETA_LOCAL_AUTH_FORBIDDEN` |
| A third-party message-delivery credential (`RESEND_API_KEY`, `INVITE_EMAIL_FROM`) is set | `BETA_DELIVERY_PROVIDER_FORBIDDEN` |
| A required key from the profile is missing | `BETA_ENV_MISSING` |
| A required beta port is already held by another process | `BETA_PORT_IN_USE` |
| Container runtime, Supabase CLI, or media tooling is unavailable | `BETA_PREREQUISITE_MISSING` |

The agent-side assertion runs before `buildServer`, so a misconfigured beta agent never binds a port
and never accepts a request.

**Why the delivery-provider row exists.** Most outbound messages in this system travel through the
platform's own transport and are therefore captured by the local mail catcher automatically. Team
invitations do not: `supabase/functions/team-invitations/email.ts` posts directly to a third-party
delivery API, which the local stack never sees. Without this guard a beta environment would send real
invitations to real people — the same class of leak as writing production analytics, and harder to
notice because every other message type behaves correctly. In beta, no delivery-provider credential
may be configured, and the invitation flow surfaces the link locally instead of sending it.

**Inverse rule, deliberately asymmetric**: when the environment is `production`, a *loopback* Supabase
or site URL is rejected in a production build. This preserves the existing check in
`apps/web/src/lib/config.ts` and closes the mirror-image mistake.

---

## Guard B — production must not carry beta

**Enforced by**: `scripts/verify-release.mjs` (already mandatory in front of every package and
deploy) and `scripts/verify-published-release.mjs`.

| Condition | Code |
|---|---|
| Release channel, version, or build id carries a beta identity | `RELEASE_BETA_IDENTITY` |
| A beta marker appears in a production-feeding file | `RELEASE_BETA_CONFIG` |
| A beta marker appears in the built `apps/web/dist` | `RELEASE_BETA_CONFIG` |
| An artifact with a beta identity appears in the published update channel | `RELEASE_BETA_IDENTITY` |
| HEAD is not contained in `beta`, or no matching verification record exists | `RELEASE_BETA_UNVERIFIED` |

**Beta markers**: `VITE_APP_ENVIRONMENT=beta`, `SOTY_ENVIRONMENT=beta`, `com.wishly.beta`,
`Soty Beta`, `wishly-beta-agent.lock`, agent port `43140`, release channel `beta`.

**Production-feeding file set** — the precise scope of FR-008, resolving the tension recorded in the
plan's Complexity Tracking:

```
.env
.env.production
apps/web/.env.production
config/production.env
packages/shared/src/release.ts
apps/web/public/.well-known/wishly/stable.json
packaging/**
```

`supabase/config.toml` is **exempt and explicitly out of the scanned set**: it configures only the
locally-run Supabase stack, is never read by the hosted project, and never travels into a production
artifact. The exemption is written into the guard rather than left to interpretation, so the check
neither produces a false failure nor silently widens.

---

## Test coverage

| Guard | Test | Asserts |
|---|---|---|
| A | `tests/beta-isolation-guards.test.ts` | Each condition above produces its exact code, including `BETA_DELIVERY_PROVIDER_FORBIDDEN`; a valid beta profile passes. Environment probes are injected, so the suite never touches the real system |
| A | `tests/beta-web-environment.test.tsx` | Badge present in beta and absent in production; analytics emits nothing in beta even with `VITE_ANALYTICS_ENABLED=true` |
| B | `tests/beta-release-gates.test.ts` | Each beta marker in each production-feeding file is rejected; a beta artifact is never verifiable by the production release-manifest key; `supabase/config.toml` containing beta redirect URLs does **not** trigger a failure |
| Promotion | `tests/beta-promotion-gate.test.ts` | Uncontained commit, missing record, mismatched revision, and dirty record each yield `RELEASE_BETA_UNVERIFIED` |
| Reset | `tests/beta-reset-guard.test.ts` | A non-loopback target fails before the first destructive operation |
| Profiles | `tests/beta-environment.test.ts` | Ports, bundle ids, support directories, and lock names are pairwise distinct across production, dev, and beta |
