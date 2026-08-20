# Quickstart: Validating the Beta Staging Environment

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Contracts**: [contracts/](./contracts/)

Runnable scenarios that prove the feature works end to end. Each maps to acceptance scenarios in the
spec. Implementation details live in `tasks.md`; this document is the validation guide.

---

## Prerequisites

| Requirement | Why | Checked by |
|---|---|---|
| Node 22 and repository dependencies installed | Builds and scripts | `beta:doctor` |
| Container runtime running (Docker Desktop or equivalent) | `supabase start` | `beta:doctor` → `BETA_PREREQUISITE_MISSING` |
| Supabase CLI available (`npx supabase`) | Local stack | `beta:doctor` |
| FFmpeg / FFprobe resolvable | Media tooling | `beta:doctor` |
| `.env.beta` created from `.env.beta.example` | Beta profile | `beta:doctor` → `BETA_ENV_MISSING` |
| Beta entitlement keypair generated | Real entitlement gating | `beta:doctor` |
| Ports 43140, 5175, 54321–54324 free | Coexistence with production and dev | `beta:doctor` → `BETA_PORT_IN_USE` |

One-time setup:

```bash
cp .env.beta.example .env.beta          # then fill in the local values the doctor names
node scripts/generate-signing-keys.mjs --beta
npm run beta:doctor
```

---

## Scenario 1 — Bring-up and full end-to-end journey (US1)

**Covers** FR-002, FR-009, FR-010, FR-011 · SC-001, SC-002, SC-002a

```bash
npm run beta:up
```

**Expect**: exit 0, the beta URL printed, and a line reporting how far `beta` is behind `main`.
Then, in the browser, complete the journey with no third-party account of any kind:

1. Sign up / sign in — the message is captured by the local mail catcher (54324), not delivered.
2. Pair the local tool — the agent issues and verifies a **beta-signed** entitlement token.
3. Run one media job to completion.
4. View the result.
5. Send a team invitation — the link is surfaced locally in the UI and **no message is sent**, because
   no delivery-provider credential exists in beta.

**Then verify nothing reached production** (SC-003, SC-013):

```bash
npm run analytics -- overview --days 1   # read-only CLI against production
```

**Expect**: zero events attributable to the beta session, no new production account, and no message
delivered to any real recipient.

Then confirm the guard is real rather than incidental:

```bash
RESEND_API_KEY=re_example_value npm run beta:doctor
```

**Expect**: exit 1, `BETA_DELIVERY_PROVIDER_FORBIDDEN`, naming `RESEND_API_KEY`. Nothing starts.

---

## Scenario 2 — Beta is unmistakable, and cannot be released (US2)

**Covers** FR-014, FR-015, FR-016a, FR-017, FR-018, FR-019 · SC-005, SC-006

- Every main screen shows the beta indicator without scrolling or opening a menu.
- The about/version surface shows environment `beta` and the exact source revision.
- A production build shows no indicator anywhere.

Then prove the gate refuses a beta artifact:

```bash
SOTY_ENVIRONMENT=beta npm run release:check
```

**Expect**: exit 1 with `RELEASE_BETA_IDENTITY`. Also confirm the published channel is clean:

```bash
node scripts/verify-published-release.mjs
```

**Expect**: exit 0 and no beta artifact listed.

---

## Scenario 3 — Beta refuses to talk to production (Edge cases, FR-006)

**Covers** FR-006, FR-027d · SC-004

Point the beta profile at a production value and try to start:

```bash
VITE_SUPABASE_URL=https://yvvvignywfmbdgkcxtfk.supabase.co npm run beta:doctor
```

**Expect**: exit 1, `BETA_PRODUCTION_ENDPOINT`, naming `VITE_SUPABASE_URL`. Nothing starts.

Repeat with `VITE_LOCAL_DEV_AUTH=true` → exit 1, `BETA_LOCAL_AUTH_FORBIDDEN`. This is the guard that
stops beta from quietly becoming a fake-auth environment like Soty Dev.

With external storage not configured, confirm Drive-dependent surfaces are visibly marked unavailable
in beta and do **not** call the production integration.

---

## Scenario 4 — Three copies at once (Edge cases, FR-007)

**Covers** FR-007 · SC-010

Run production (installed app), an ordinary `npm run dev`, and `npm run beta:up` simultaneously for a
working session.

**Expect**: no port conflicts (43120 / 43130 / 43140, 5173 / 5175), no shared Application Support
directory, no instance-lock contention, and each copy identifiable at a glance.

---

## Scenario 5 — Reset to a known-clean state (US4)

**Covers** FR-024, FR-025, FR-026 · SC-007

Dirty the environment with several jobs and accounts, then:

```bash
npm run beta:reset
```

**Expect**: under 5 minutes to a clean, fixture-seeded baseline — the beta account, one workspace,
one sample media item — and Scenario 1's journey succeeds immediately afterwards with no extra setup.

Then prove the reset cannot reach production:

```bash
SUPABASE_DB_URL=<a non-loopback URL> npm run beta:reset
```

**Expect**: exit 1, `BETA_RESET_TARGET_UNSAFE`, before any write.

---

## Scenario 6 — Packaged beta build (US1/US2, packaged mode)

**Covers** FR-002a, FR-002b

```bash
npm run beta:package
npm run beta:verify
```

**Expect**: an app identified as `Soty Beta` / `com.wishly.beta`, channel `beta`, port 43140, support
directory `Soty Beta`, entitlement **enforced** with the beta key, and `VITE_LOCAL_DEV_AUTH` absent
from the bundle. `release/beta/verification.json` is written with the source revision.

Confirm production identity is untouched:

```bash
git status --porcelain packages/shared/src/release.ts apps/web/public/.well-known/wishly/stable.json config/production.env
```

**Expect**: empty output.

---

## Scenario 7 — Promotion to a real release (US3)

**Covers** FR-020, FR-020a, FR-021, FR-022, FR-023 · SC-008, SC-011, SC-012

With a change verified in beta:

```bash
git checkout main && git merge beta
npm run release:check
```

**Expect**: the promotion gate passes only because HEAD is contained in `beta` and a matching
verification record exists.

Negative checks — each must fail:

- Release a commit that is **not** contained in `beta` → `RELEASE_BETA_UNVERIFIED`.
- Reuse a verification record from a **different** revision → `RELEASE_BETA_UNVERIFIED`.
- Commit a beta value into any production-feeding file → `RELEASE_BETA_CONFIG`.
- Add beta redirect URLs to `supabase/config.toml` → **must pass**; that file is exempt by design.

---

## Automated coverage

```bash
npm test -- tests/beta-environment.test.ts tests/beta-isolation-guards.test.ts \
            tests/beta-analytics.test.ts tests/beta-release-gates.test.ts \
            tests/beta-promotion-gate.test.ts tests/beta-reset-guard.test.ts \
            tests/beta-web-environment.test.tsx
```

Plus the standard gates before any PR: `npm run format:check`, `npm run lint`, `npm test`, and a
build of `apps/agent` (which CI never builds).
