<!--
Sync Impact Report
==================
Version change: [TEMPLATE / unversioned] → 1.0.0
Rationale: Initial ratification. The file was still the unfilled template; this is the
first concrete constitution, derived from a full codebase analysis (agent, web, shared,
scripts, supabase, tests). Treated as MAJOR/initial baseline 1.0.0.

Principles defined:
  I.   Type-Safe Contracts, Validated at the Boundary
  II.  One Source of Truth for the Release & Protocol Contract
  III. Security and Least Privilege by Construction
  IV.  Disciplined Child-Process & Resource Orchestration
  V.   Consistent HTTP API & Error Conventions
  VI.  Frontend Composition & State Discipline

Sections:
  Added: "Additional Constraints: Stack, Tooling & Code Style"
  Added: "Development Workflow & Quality Gates"
  Added: "Governance"

Templates / files requiring follow-up: none pending. Downstream Spec Kit templates read
this file at runtime; no structural placeholders remain.

Deferred TODOs: none. RATIFICATION_DATE set to first adoption (2026-08-01) since no earlier
adoption date is recorded in git or docs.
-->

# Soty (local-video-compressor) Constitution

This constitution governs the Soty monorepo — a local, privacy-first media toolkit.
Identity spans three names on purpose: the npm root package is `local-video-compressor`,
the workspace scope is `@video-compressor/*`, the product brand is **Soty**, and the
GitHub repo is `AffSupport`. Newcomers MUST expect all four and MUST NOT "unify" them.

The system is an npm-workspaces monorepo: a local Fastify **agent** (`apps/agent`), a
React + Vite **web** app deployed to Cloudflare Pages (`apps/web`), a **shared** contract
package (`packages/shared`), Supabase (auth, analytics, edge functions), and a family of
Node/zsh scripts for release, packaging, and read-only analytics.

## Core Principles

### I. Type-Safe Contracts, Validated at the Boundary

Everything compiles under `strict: true` with ESM `NodeNext` (internal imports MUST carry
explicit `.js` extensions, including type-only imports). Trust nothing that crosses a
process, network, or storage boundary.

- Domain types, constants, and validators live in `@video-compressor/shared` and are
  imported as `import type` where only types are needed. Shared numeric bounds
  (`CRF_MIN/MAX`, bitrate caps) and `clamp*` helpers are the canonical guards — reuse them,
  do not re-derive limits inline.
- Untrusted input (request bodies, SSE payloads, `ffprobe`/tool JSON, parsed env) MUST be
  typed `unknown` and narrowed with explicit type guards or a discriminated-union parse
  result (`{ ok: true; value } | { ok: false; error }`) — never trusted straight from a
  route generic and never cast with `as`.
- Model state and results as string-literal state machines and discriminated unions
  (`ConnectionState`, `AuthStatus`, `ConfigResult.ok`), so branches are exhaustive and
  a typo can't silently skip a case.

**How NOT to do it:** `reply: any` on route helpers; `Record<string, any>` for external
tool JSON; `as SomeType` on an unvalidated payload; adding a magic numeric limit inline
instead of using the shared `clamp*`/`*_MIN/MAX` constants; importing without the `.js`
suffix (breaks at runtime under NodeNext).

### II. One Source of Truth for the Release & Protocol Contract

`packages/shared/src/release.ts` is the single origin of version and protocol identity:
`PRODUCT_VERSION`, `BUILD_NUMBER`, `AGENT_API_VERSION` (with its supported MIN/MAX range),
the per-tool contract maps, the signing public key, and derived artifact URLs. Release
identity and contract versions are intentionally decoupled and MUST stay so.

- Version, artifact, and manifest facts MUST be read from `release.ts` (or the shared
  `dist`), never hard-coded in an app, script, or test.
- Every workspace `package.json`, the `stable.json` manifest, and `config/production.env`
  MUST agree with `release.ts`; `scripts/verify-release.mjs` is the gate that proves it and
  MUST pass before any deploy or package.
- Because `packages/shared/dist` is committed, any script or command that consumes the
  contract MUST rebuild shared first (`npm run build -w @video-compressor/shared`) so it
  validates against current constants, not a stale `dist`.

**How NOT to do it:** bumping a version by editing a `package.json` by hand; duplicating
a download URL or sha256 in a script; running `node scripts/verify-release.mjs` against a
stale `dist`; treating `AGENT_API_VERSION` and `PRODUCT_VERSION` as the same number.

### III. Security and Least Privilege by Construction

Security is enforced structurally, in layers, not by convention. New surfaces MUST inherit
the existing posture rather than open a hole beside it.

- **Database:** every table has RLS enabled with `revoke all` then narrow, column-scoped
  `grant`s. SQL functions are `security definer` with `set search_path = ''` and
  fully-qualified names. Client-facing access to sensitive tables goes through
  `security definer` functions/views (`is_admin()`, `analytics_users`), never a broad
  policy. Reads that must be read-only run as the dedicated `wishly_analytics_ro` role.
- **Analytics CLI is read-only by construction, in three independent layers** (SELECT-only
  role, forced `default_transaction_read_only`, and `assertReadOnlySql` on every query).
  All three MUST remain; user values MUST be bound parameters. The only interpolation
  permitted is identifiers chosen from a closed, enum-validated set.
- **Agent/web boundary:** origin allowlists, per-boot random session tokens, timing-safe
  comparison for native/entitlement tokens, and entitlement gating with an explicit exempt
  set. `verify-web-env.mjs` MUST keep asserting the browser Supabase key is non-privileged.
- **Secrets:** private keys live only under the git-ignored `config/keys/`. Tracked env
  files (`config/production.env`, `apps/web/.env.production`) carry public keys and origins
  only. Never add a secret to a tracked file.

**How NOT to do it:** a `security definer` function without `set search_path = ''`; a table
without RLS or with a blanket `using (true)` client policy; threading user input into a SQL
identifier; `exception when others then` that swallows real schema errors as if they were
delivery hiccups; `rejectUnauthorized: false` copied into new clients; committing a
`*.private.pem` or an API secret.

### IV. Disciplined Child-Process & Resource Orchestration

The agent's core job is orchestrating external binaries (FFmpeg, whisper, translation,
Playwright). This is done one way.

- Spawn with `spawn(cmd, args, { shell: false })` — **never** a shell string. Wrap each
  spawn in a Promise that resolves a result object (`{ code, stderr, spawnErrorCode }`) and
  does not reject on non-zero exit; treat tool failure as data mapped to a typed error
  (`MediaToolUnavailableError`, `WhisperUnavailableError`) with an `isXError` guard.
- Buffered stderr MUST be bounded (`slice(-N)`); progress MUST come from streamed
  line-buffering, not accumulating full output.
- Cancellation, watchdog, and shutdown MUST track the live child and escalate
  SIGTERM → SIGKILL after a timeout, with timers `.unref()`'d.
- Every temp path uses `mkdtemp` + `try/finally` recursive cleanup; atomic installs stage to
  a temp dir then `rename`. On a rejected multipart upload, always `part.file.resume()` to
  drain the stream and check `part.file.truncated`.
- Binary/model resolution follows the fixed three-tier order: `X_PATH` env override →
  writable App-Support download dir → bundled read-only runtime, keyed on
  `PACKAGED_APP === '1'`.

**How NOT to do it:** `shell: true` / interpolating a filename into a command string;
letting stderr grow unbounded; a cancel path that doesn't hold a reference to the running
child; a new upload route that forgets to drain or to check `truncated`; relying on the
100 GB global multipart limit instead of a per-route `bodyLimit`.

### V. Consistent HTTP API & Error Conventions

The agent's HTTP layer is dependency-injected and composed from feature modules; there is
no module-level server state, which is what lets tests assemble a real server.

- Each feature exposes `registerXRoutes(app, deps)` and implements the `ToolModule`
  interface (`id`, `register`, `busy`, `shutdown`); routes, the `/health` busy flag, and
  the shutdown chain all iterate the one module list.
- Success returns the tool's state snapshot (or `{ state, warnings }`); errors return
  `reply.code(N).send({ error })`. Status codes are used deliberately and consistently
  (400 invalid, 401 token, 403 origin/entitlement, 404, 409 wrong-state, 413 too large,
  501 unsupported platform, 503 engine unavailable, 202 accepted-async).
- The `error` value MUST be a stable machine code (`UPDATE_PENDING`, `IMAGE_SLOT_INVALID`),
  not a human sentence, so clients can branch on it. Background/async errors funnel through
  the single `logError` sink and Fastify's Pino logger.

**How NOT to do it:** mixing human-sentence and machine-code errors in the same surface;
inventing a new response envelope per route; writing to a raw SSE socket with no per-client
guard; leaving a background promise rejection outside the `logError` chain.

### VI. Frontend Composition & State Discipline

The web app is 100% functional components with hand-rolled routing, one global stylesheet,
and no data-fetching library — keep new code inside these established seams.

- Global stores use the context idiom: `createContext<T | null>(null)`, a `useX()` hook that
  throws if used outside its provider, and an `XContextOverride` for tests. Read i18n via
  `useI18n()` (`t(key, values)`); localization is a compile-checked `TranslationKey` union,
  not a runtime library.
- Call the agent only through the typed one-line wrappers in `api/client.ts`
  (`request`/`requestBody`/`uploadForm` → `assertOk`); call Supabase via
  `getSupabaseClient()` handling `{ data, error }` explicitly. Live state is SSE via a
  single subscribe-and-reconnect path, not polling.
- Emit telemetry with `analytics.track(typedName, props)` where the name is a constrained
  union and props are typed per event. Style with `className` strings against `styles.css`
  and theme via CSS custom properties + `data-theme`; reserve inline `style` for computed
  values. Keep `any` out of `src` (the tree is currently `any`-free — keep it that way).

**How NOT to do it:** growing 1,000+-line multi-responsibility files (the existing
`TranscriptTextModal.tsx` / `i18n.ts` are debts, not templates); copy-pasting the
SSE + toast + error-handling boilerplate into a new page instead of extracting a shared
hook; prop-drilling `t` through a component chain; stringly-typed error branches on
`error.message === 'PAIRING_REQUIRED'` typos; pinning deps to `"latest"`.

## Additional Constraints: Stack, Tooling & Code Style

- **Language & modules:** TypeScript everywhere, `strict: true`, ESM (`"type": "module"`,
  `module/moduleResolution: NodeNext`, `target: ES2022`). Internal imports use `.js`
  specifiers.
- **Formatting (Prettier, non-negotiable):** `singleQuote`, `trailingComma: none`,
  `printWidth: 100`, `arrowParens: avoid`. Run `npm run format` before proposing changes.
- **Linting (ESLint flat config):** `js.recommended` + `typescript-eslint.recommended`.
  `no-explicit-any` is intentionally OFF, but Principle I still forbids gratuitous `any`;
  unused vars are an error except when prefixed `_`.
- **Script languages by purpose:** `.mjs` for anything importing the shared contract or
  doing crypto/git; `.sh` (zsh, `set -euo pipefail`) for packaging/DMG/native work; `.ts`
  via `tsx` only for the analytics CLI. mjs scripts use a local `fail()` →
  stderr + `process.exit(1)` and print a human confirmation line on success.
- **Supabase migrations:** `YYYYMMDDHHMMSS_<slug>.sql`, forward-only, with reverse steps
  documented in `ROLLBACK.md`. Regenerate DB types with `npm run types:supabase`.
- **Envelope conventions are contracts:** the analytics CLI's
  `{ ok, command, generated_at, period, data }` / `{ ok: false, command, error }` shape and
  the agent's state-snapshot / `{ error }` responses are stable API surfaces — extend, don't
  reshape.

## Development Workflow & Quality Gates

- **Local gates before a PR:** `npm run format:check`, `npm run lint`, and `npm test`
  (which builds `shared` then runs `vitest run`) MUST pass. Because there is no `tsc
--noEmit` script, run the relevant `build` to catch type errors — especially for
  `apps/agent`, which CI never builds.
- **Test conventions:** all tests live in the central `tests/` directory as `*.test.ts(x)`
  (never co-located, never `*.spec`). DOM tests opt into jsdom with a
  `// @vitest-environment jsdom` docblock. Mock with `vi.hoisted` + `vi.mock` (no msw/nock).
  DB query tests use PGlite; filesystem/server integration tests use `mkdtemp` + an
  `afterEach` recursive cleanup. `scripts/real-agent-check.mjs` (`test:agent:e2e`) is the
  real end-to-end harness and requires a full build.
- **Verification is one command, and it runs on every pull request:**
  `npm run verify` (fast) and `npm run verify:release` (full) run every gate
  through `scripts/verify-all.mjs`, and `.github/workflows/verify.yml` runs them
  on pull requests and on the default branch across macOS, Windows and Linux.
  The two forms differ only in which gates run, never in how a result is
  reported. This paragraph previously warned that nothing ran on PR or push and
  that contributors carried the gate by hand; feature 009 closed that.
- **Anti-patterns to fix, not copy:** real-binary tests that `if (!available) return;`
  report as PASSING when a tool is absent — use `it.skipIf`/`ctx.skip()` so they show as
  skipped. Do not pin `apps/web` deps to `"latest"`.
- **Release & deploy gating (Principle II) is mandatory:** `deploy:web` chains
  `verify-web-env` → `build:web` → `verify-release --deploy` → `verify-published-release` →
  `wrangler pages deploy`. A web-only deploy MUST NOT contain un-released agent/shared
  changes; the release git tag MUST exist and match the deployed commit; a published tag is
  never rebuilt.
- **Operational guardrails:** the analytics CLI MUST stay read-only (never make it write).
  Dev/test builds use `npm run package:dev:dmg` and MUST NOT touch production versions,
  the stable manifest, git tags/releases, Supabase migrations, or Cloudflare.

## Governance

This constitution supersedes ad-hoc convention. When code and this document disagree, the
document wins for new work; divergences observed in existing code are debts to pay down, not
precedents to extend (each anti-pattern above marks one such debt).

- **Compliance:** every change (and every AI-assisted change) MUST be checkable against these
  principles. Reviewers MUST reject changes that violate a MUST without an explicit,
  documented justification in the PR. Added complexity MUST be justified against the
  simplest approach that satisfies the principles.
- **Amendment procedure:** amendments are proposed via PR editing this file, MUST include an
  updated Sync Impact Report, and MUST be reviewed by a maintainer. Merging the PR ratifies
  the amendment.
- **Versioning policy (semantic):** MAJOR for backward-incompatible governance changes or
  principle removals/redefinitions; MINOR for a new principle/section or materially expanded
  guidance; PATCH for clarifications and wording. The version line below MUST match the Sync
  Impact Report.
- **Runtime guidance:** `AGENTS.md` (agent workflows, analytics CLI, dev builds) and the
  Spec Kit templates under `.specify/` provide operational detail and MUST stay consistent
  with these principles.

**Version**: 1.0.0 | **Ratified**: 2026-08-01 | **Last Amended**: 2026-08-01
