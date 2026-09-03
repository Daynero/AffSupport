# Implementation Plan: 2FA Notebook

**Branch**: `016-totp-notebook` | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/016-totp-notebook/spec.md`

## Summary

A sixth tool in the Soty catalogue, and the first one that needs nothing from
the local agent: a personal notebook of 2FA seeds, one row each, with a copy
button for the seed and a single press that computes the six-digit code and
puts it on the clipboard.

The technical shape follows from three findings in the existing code:

1. **The seeds go in Supabase Vault, reached through owner-scoped
   `security definer` RPCs.** The repository already stores Google Drive
   refresh tokens this way (`private.store_google_drive_credential`), so this
   feature extends an established pattern instead of inventing storage. The
   difference is the grant: Drive credentials are `service_role`-only, while
   these functions are granted to `authenticated` and filter on `auth.uid()`,
   because the owner's own browser is what needs the seed.
2. **The code is computed in pure, synchronous TypeScript in
   `packages/shared`.** Not Web Crypto: `crypto.subtle` is async, and an
   `await` between the click and `clipboard.writeText` costs the user-activation
   that Safari requires for a clipboard write. A synchronous HMAC-SHA-1 keeps
   "one press → code in the clipboard" a single, uninterrupted turn.
3. **The tool registry needs a browser-only tool kind.** Every tool today is an
   agent tool: `WebTool.id` is a `SotyToolId`, and both `HomePage.openTool` and
   `ProtectedSoty.ToolRoute` gate on `toolAvailable(tool.id)`. `SotyToolId` is
   `keyof WEB_TOOL_REQUIREMENTS`, and that map is byte-compared against the
   signed, published `stable.json` by `verify-release.mjs` — so adding this
   tool to it would block `deploy:web` until an agent release published a
   contract this tool does not use. The registry gains a `runtime` field
   instead; `'browser'` tools skip the capability checks and the setup dialog.

No new npm dependency, no agent change, no change to the release contract.

## Technical Context

**Language/Version**: TypeScript 5.9, `strict: true`, ESM with
`module/moduleResolution: NodeNext` (internal imports carry `.js`), target
ES2022.

**Primary Dependencies**: React 19.2, `@supabase/supabase-js` 2.110,
`lucide-react` 1.37, `@video-compressor/shared` (workspace). **No new
dependency is added** — the TOTP algorithm is implemented in `shared`, which
today has zero runtime dependencies and stays that way.

**Storage**: Supabase Postgres. A `private.two_factor_entries` table holding
the name and a `vault_secret_id`; the seed itself lives in `vault.secrets`.
All client access goes through four `security definer` RPCs in `public`.

**Testing**: Vitest, all tests in the central `tests/` directory as
`*.test.ts(x)`. Algorithm tests are plain Node; UI tests opt into jsdom with a
`// @vitest-environment jsdom` docblock and mock via `vi.hoisted` + `vi.mock`;
SQL tests run the real migration chain on PGlite through
`tests/support/team-db.ts` (which already stubs the `vault` schema); an RLS
assertion goes in the pgTAP suite under `supabase/tests/database/`.

**Target Platform**: The browser — `apps/web`, deployed to Cloudflare Pages.
Also runs inside the packaged desktop app's copy of the web app, where it works
identically because it needs nothing from the agent.

**Project Type**: A web app in an npm-workspaces monorepo, plus a shared
contract package and Supabase migrations. No agent, CLI or packaging work.

**Performance Goals**: Code generation and clipboard write complete inside the
click handler with no `await` before the write (SC-001). Search filters rows
already in memory, so 200 entries narrow within one frame (SC-004). The
notebook loads in one RPC round trip.

**Constraints**: The clipboard write must stay inside the user gesture. No seed
may reach a log, an analytics property or a URL (FR-008) — note that the
analytics payload guard in `analytics_properties_are_safe_v2` already rejects
any value matching `(bearer|oauth|token=|authorization)`, so the analytics tool
identifier is `two-factor`, with no seed-shaped property ever attached. No new
external origin, so `generate:csp` output is unchanged.

**Scale/Scope**: A few hundred entries per person; one page, one context, one
row component, one small form, four RPCs, one migration, one shared module.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How this feature satisfies it |
| --- | --- |
| **I. Type-safe contracts, validated at the boundary** | RPC rows arrive as `unknown` and are narrowed by explicit mappers in `api/two-factor.ts`, in the shape `team.ts` already uses (`mapX(row) \| null`, then reject the batch on any `null`). The seed parser returns a discriminated `{ ok: true; value } \| { ok: false; error }` rather than throwing or casting. No `as` on an unvalidated payload; `.js` suffixes on internal imports. |
| **II. One source of truth for the release & protocol contract** | Nothing is added to `WEB_TOOL_REQUIREMENTS` or `AGENT_TOOL_CONTRACTS`: this tool uses no agent contract, and touching that map would fail the signed-manifest byte comparison in `verify-release.mjs` and block `deploy:web`. This is the *reason* for the registry's new `runtime` field, not an oversight. |
| **III. Security and least privilege by construction** | The table lives in `private` with RLS enabled and `revoke all`; no client-facing policy grants direct access. Seeds live in Vault, reached only through `security definer` functions that are `set search_path = ''`, use fully-qualified names, and filter every statement on `auth.uid()`. Functions are granted to `authenticated` and revoked from `public`/`anon`. A delete removes the vault secret as well as the row. No seed in any log, analytics event or URL. |
| **IV. Disciplined child-process & resource orchestration** | Not engaged — no child process, no temp file, no binary. |
| **V. Consistent HTTP API & error conventions** | Not engaged — no agent route. The web side keeps the equivalent discipline: a stable machine code (`INVALID_SECRET`, `ENTRY_NOT_FOUND`) on every failure path, never a human sentence, so the UI branches on codes and the copy comes from i18n. |
| **VI. Frontend composition & state discipline** | A `TwoFactorContext` in the house idiom (`createContext<T \| null>(null)`, a `useTwoFactor()` that throws outside its provider, an override for tests). Supabase through `requireSupabaseClient()` with `{ data, error }` handled explicitly. Strings through `useI18n()` as compile-checked `TranslationKey`s. Styling by `className` against `styles.css` with the compressor's tokens. `analytics.track` with a typed name. No `any`. The page is split into page / row / form / context files rather than growing one large file. |

**Gate result (pre-research): PASS.** No violations.

**Re-check after Phase 1 design: PASS, with two things the design made
concrete.** First, principle III got stricter rather than looser during design:
the table moved to the `private` schema, so no PostgREST route reaches it at
all, and `update`/`delete` raise `ENTRY_NOT_FOUND` for a row owned by someone
else — the same code as a missing row — so the functions cannot be used to
probe for other people's ids. Second, principle II is the reason the design has
a `runtime` field at all; the quickstart therefore runs
`node scripts/verify-release.mjs` as an explicit gate, and it must pass with no
agent release. No violations, so the Complexity Tracking table below stays
empty.

## Project Structure

### Documentation (this feature)

```text
specs/016-totp-notebook/
├── plan.md              # This file
├── research.md          # Phase 0 output — the five decisions and what was rejected
├── data-model.md        # Phase 1 output — table, vault link, validation, lifecycle
├── quickstart.md        # Phase 1 output — how to run and prove it
├── contracts/
│   ├── rpc.md           # The four Supabase RPCs: arguments, rows, error codes
│   └── totp.md          # The shared TOTP module's public surface and test vectors
├── checklists/
│   └── requirements.md  # Written by /speckit-specify, all items passing
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/shared/src/
├── totp.ts                      # NEW. Base32 decode, SHA-1, HMAC-SHA-1, RFC 6238
│                                #      code derivation, otpauth:// parsing. Synchronous,
│                                #      dependency-free, no DOM and no Node built-ins.
└── types.ts                     # EDIT. Re-export the TOTP types with the other domain types.

apps/web/src/
├── lib/
│   ├── tool-registry.ts         # EDIT. `runtime: 'agent' | 'browser'`; widen the id type;
│   │                            #       register the notebook with its icon and path.
│   ├── feature-flags.ts         # EDIT. Add the `twoFactorNotebook` acknowledgement flag.
│   └── database.types.ts        # EDIT. Hand-add the four function signatures, as 015 did,
│                                #       with the same explanatory comment.
├── components/
│   └── tool-icons.tsx           # EDIT. Add the catalogue icon, in the existing 32×32 style.
├── api/
│   └── two-factor.ts            # NEW. The four RPC wrappers + row mappers + error type.
├── two-factor/
│   ├── TwoFactorPage.tsx        # NEW. Pinned search, the list, the empty states.
│   ├── TwoFactorContext.tsx     # NEW. Entries, loading/error state, the mutations.
│   ├── TwoFactorRow.tsx         # NEW. One line: name, 2fa marker, four buttons.
│   ├── TwoFactorForm.tsx        # NEW. The add/edit dialog, one form for both.
│   └── clock-skew.ts            # NEW. One HEAD request's Date header vs the local clock.
├── HomePage.tsx                 # EDIT. A browser tool opens instead of asking for the app.
├── ProtectedSoty.tsx            # EDIT. A browser tool renders instead of the setup screen.
├── analytics/events.ts          # EDIT. Add 'two-factor' to the AnalyticsTool union.
├── i18n.ts                      # EDIT. The tool's strings, in `en` and `uk`.
└── styles.css                   # EDIT. The row, the marker, the pinned search bar.

supabase/
├── migrations/
│   └── 2026090xxxxxxx_two_factor_notebook.sql   # NEW. Table, RLS, four RPCs, grants.
├── tests/database/
│   └── two-factor.test.sql                      # NEW. pgTAP: a non-owner reaches nothing.
└── migrations/ROLLBACK.md                       # EDIT. The reverse steps for the migration.

tests/
├── totp.test.ts                 # NEW. RFC 6238 vectors, Base32 edge cases, otpauth parsing.
├── two-factor-sql.test.ts       # NEW. PGlite: the four RPCs, ownership, vault cleanup.
├── two-factor-ui.test.tsx       # NEW. jsdom: row actions, clipboard, search, empty states.
└── tool-registry.test.ts        # EDIT or NEW. A browser tool never consults the agent.
```

**Structure Decision**: The feature spans the three workspaces it has to and no
more — the algorithm in `packages/shared` (so it is testable in plain Node and
has one home), the interface in `apps/web` under its own `two-factor/`
directory beside `stitcher/` and `transcription/`, and the storage in
`supabase/migrations`. `apps/agent`, `packaging/`, `release/` and `scripts/`
are untouched, which is what keeps this a web-only deploy.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. The Constitution Check above passes on every engaged principle,
and the one structural change to shared code (the registry's `runtime` field)
exists specifically to *avoid* a violation of Principle II.
