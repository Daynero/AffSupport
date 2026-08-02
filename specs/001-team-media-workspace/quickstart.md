# Quickstart & Validation: Командний медіапростір Wishly

Runnable validation guide for the design in [data-model.md](./data-model.md) and
[contracts/](./contracts/). It intentionally contains no implementation bodies, migrations
or complete test suites.

## Prerequisites

- Node `>=22.12.0` (Node 22 project standard), npm, and a Docker-compatible runtime.
- `npm install` completed at repository root.
- Supabase CLI through `npx supabase`; local stack uses PostgreSQL 17
  (`[db].major_version = 17`).
- An isolated Supabase development project for linked type generation/deployment. Confirm
  its project ref before any `db push`; never point these steps at production.
- Google Cloud web OAuth client with Drive API enabled, offline redirect registered at the
  real `/functions/v1/drive-oauth-callback` URL, and restricted `drive` scope configured.
  Production pilot additionally requires completed Google restricted-scope verification/
  security assessment.
- Resend API key + verified sending domain for invitation delivery.
- Two Google test accounts, one My Drive folder and one Shared Drive folder containing a
  video, image, transcript, zip/landing package, duplicate name, corrupt archive, shortcut
  to an outside file, and a file the connected account cannot trash.

For local Edge functions, create a git-ignored `supabase/functions/.env.local` containing
test-only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`,
`INVITE_EMAIL_FROM`, `CATALOG_SYNC_SECRET`, `DRIVE_OAUTH_MODE=testing`, and existing
Wishly/Supabase values. The tracked `.env.example` uses `DRIVE_OAUTH_MODE=disabled`; only a
verified production deployment may set `verified`. Dynamic
refresh tokens are created in local Vault; there is no `DRIVE_TOKEN_KEY` or per-team env
secret.

If the Resend sending domain is temporarily unavailable, set
`TEAM_DIRECT_ADD_MODE=testing` in the Edge environment and
`VITE_TEAM_DIRECT_ADD_MODE=testing` in the matching web build. In this labelled pilot mode,
the member form accepts only an existing active Wishly account's exact confirmed email and
adds it immediately; an unknown/unconfirmed account returns `NOT_FOUND`. Both settings
default to `disabled` and must be disabled when normal invitation delivery is restored.
The provider-readiness endpoint may report `ready=true` for this usable pilot path while
retaining `fullProviderReady=false` and `memberOnboarding=direct_add_testing`; only verified
Resend configuration makes `fullProviderReady=true`.

For the isolated hosted dev project, set the same configuration with `supabase secrets set`
only after verifying the linked project. Local `functions serve` does not automatically use
remote secrets.

## Local stack and gates

```bash
npx supabase start
npx supabase db reset
npx supabase functions serve --env-file supabase/functions/.env.local
```

In separate terminals:

```bash
npm run dev
```

Before review:

```bash
npm run generate:team-contract -- --check
npm run format
npm run format:check
npm run lint
npm test
npm run test:db
npm run build -w @video-compressor/web
npm run build -w @video-compressor/agent
```

After applying migrations to the isolated linked dev project, run
`npm run types:supabase` and commit the generated type update. Rollback documentation must
extend `supabase/migrations/ROLLBACK.md`.

## Validation scenarios

### V1 — Contract/config baseline

1. Confirm installed React 19/Vite 8/Fastify 5/PG17 versions match `plan.md`.
2. Run `npm run generate:team-contract` twice; the npm script must first run
   `npm run build -w @video-compressor/shared`, and the second run has no diff.
3. Run the process-level stale-`dist` fixture: in a temporary minimal workspace make shared
   source newer/different than committed `dist` while generated SQL matches stale output;
   `npm run generate:team-contract -- --check` must rebuild and report drift, then a normal
   generation and repeated check converge.
4. Run parity tests for roles, permission flags, invite TTL, member cap, transfer/transcript
   limits, classifier/editor rules, GEO/language rows and `teamWorkspace` agent contract.
5. Inventory every feature SQL function: each is definer, has empty `search_path`, fully
   qualified behavior and exactly its authenticated/service EXECUTE ACL. Test null caller,
   spoofed actor, foreign team, inactive/removed profile and caller search-path shadowing.
6. Connect an old agent: web shows `AGENT_UPDATE_REQUIRED` only for team preview/process;
   current non-team tools remain compatible.

**Pass**: no `latest` dependency remains in touched web manifests, no stale shared `dist`,
and contract/version checks are deterministic.

### V2 — Create, invite, capacity and delivery (User Story 1, SC-001)

1. Create a team; inspect DB through test assertions: one active membership and exactly one
   canonical owner.
2. Invite an existing account by email and a new email. Reinvite the existing account via
   the account form: no duplicate row.
3. Simulate Resend failure: invitation remains pending, `delivery_state=failed`, and appears
   in-app; resend rotates token/expiry.
4. Verify wrong/unconfirmed email, replayed token and token after 14 days fail.
5. Fill 50 active members and accept one more invite concurrently: exactly one request can
   reach the cap; excess is `TEAM_MEMBER_LIMIT`.
6. With direct-add mode disabled, call `direct-add`: verify `WRONG_STATE` and zero lookup,
   membership, invitation-delivery, or audit side effects. Enable `testing`; add an existing
   confirmed account and verify one active membership, matching pending invite revoked,
   `membership.direct_added` audit, and no delivery call. Unknown/unconfirmed email returns
   `NOT_FOUND`; non-manager, duplicate, and member 51 remain denied.

7. Moderate 20 first-time owners from authenticated workspace-open until team exists, first
   invite is persisted, root is confirmed, and initial sync is queued. Assistance,
   abandonment, or >300 s is failure.

**Pass**: at least 18/20 complete the onboarding flow; delivery failure never masquerades as
acceptance.

### V3 — Roles, ownership, block/delete (User Story 2, SC-002, SC-003)

1. Viewer cannot upload/edit/delete/manage; editor uploads but cannot delete; admin manages
   members but cannot transfer ownership or change root.
2. Change an override and verify the next action reflects it within 10 seconds.
3. Remove a member during a multi-range transfer: next range/finalize is denied; no new
   operation starts.
4. Concurrently transfer/remove owner: only atomic transfer commits and exactly one owner
   remains.
5. Call account deletion as owner → `OWNERSHIP_TRANSFER_REQUIRED`; transfer then delete.
6. Block a user while JWT remains valid: direct RPC/Edge action is denied.
7. Give one user `edit=false, manage_metadata=true`: metadata works but rename/move/TXT edit
   fail. Invert the flags: rename/move/eligible TXT edit work but metadata fails.

**Pass**: every forbidden action changes no Postgres/Drive object and leaks no hidden data.

### V4 — OAuth, root and Shared Drive safety (User Story 1)

1. Test the entire `DRIVE_OAUTH_MODE × environment` matrix: disabled rejects both; testing
   allows only local/isolated dev; verified allows both. Missing/invalid parses disabled.
   A production `WISHLY_SITE_URL`, request origin, or transaction origin overrides a falsely
   labelled environment and rejects testing with `OAUTH_APPROVAL_REQUIRED`.
2. Confirm every gate rejection is 503 structured JSON (or fixed callback 303), creates no
   OAuth transaction/provider request/Vault secret/connection mutation, and preserves
   existing team/catalog state. Change mode between start and callback and test again.
3. Start OAuth and confirm callback has no Supabase Authorization header but succeeds once
   with valid state+PKCE; replay/expired/swapped state fails.
4. Verify broad Google token never appears in browser devtools, Picker, logs or DB public
   columns; Vault ciphertext/id are not selectable by authenticated.
5. Select roots through the server folder browser for My Drive and Shared Drive.
6. Rename/move the root externally: id-based connection remains valid. Trash/revoke access:
   state becomes unavailable/needs_reauth without deleting team metadata.
7. Run once with the Google OAuth app in Testing and simulate its time-limited refresh-token
   expiry/`invalid_grant`: reauth preserves team/catalog state and replaces, rather than
   silently nulling, the Vault secret.
8. Try root itself and an inside shortcut targeting an outside file: move/trash/dereference
   are refused with `ROOT_ESCAPE`/`UNSUPPORTED_MEDIA`.
9. Use a target whose per-file `canTrash=false`: Wishly refuses even if connection snapshot
   previously showed write capability.

**Pass**: every side effect proves live source/destination ancestry and item capabilities;
Shared Drive calls work with all-drives flags.

### V5 — Catalog/search and durable sync (User Story 3, SC-004, SC-005)

1. Begin initial scan of a 50,000-material fixture, terminate worker mid-page, restart, and
   confirm checkpointed completion without duplicate rows.
2. Change a file during initial scan; change-token replay converges afterward.
3. Move files into/out of root, rename/trash/restore and revoke access externally; incremental
   sync upserts/tombstones correctly while provenance remains.
4. Run one classifier table through initial sync, incremental sync, generic upload, text-edit
   finalize and new-version finalize. Cover explicit MIME, generic/missing/conflicting MIME,
   casefolded extension, folder, shortcut, other, archive, validated landing ZIP promotion,
   and reset after source version change; outputs and preserved original type must match.
5. Ingest `.txt/.srt/.vtt` at/over 1 MiB, UTF-8 BOM, split multibyte boundary, invalid UTF-8,
   NUL, malformed cues, and provider failure. Verify bounded fetch, safe cue text, full/
   truncated/error state, source-version conditional commit, requeue on change, and body
   clearing on tombstone. Realtime/analytics/audit/logs contain no transcript body.
6. Search name, tag, GEO, offer, language and transcript; combine all facets; query unfilled
   values; inspect team offer suggestions.
7. As non-member/no-view, exact hidden name returns no row/count/facet/hint.
8. On dedicated 4 vCPU/8 GiB/SSD with Node 22 + local PG17 and no concurrent work, load the
   fixed exactly-50k visible fixture plus hidden rows, record fixture/query-manifest hashes,
   run three repetitions of 20 warmups then 100 searches + 100 filter changes through the
   authenticated typed wrapper, and record p50/p95/p99/max overall and by subgroup. Retain
   `EXPLAIN (ANALYZE, BUFFERS)` only as diagnostic.
9. Moderate 20 first-use media buyers against the unfiltered fixture: five target assignments
   per GEO/offer/language/category. Stop only when the exact target opens; help, wrong target,
   or >30 s fails.

**Pass**: every run's overall/search/filter p95 is <2 s, no hidden leak, and at least 18/20
participants open the exact target within 30 s.

### V6 — Preview isolation (User Story 4, SC-006)

1. Run 100 controlled preview attempts: 20 each video/image/transcript/archive/landing, half
   cold and half warm, at 50 Mbps down, 10 Mbps up, 50 ms RTT, 0% loss. Measure first decoded
   frame/pixels/readable text/archive entry/safe landing representation.
2. Transcript renders authorized full/truncated/safe SRT/VTT cue text, explains invalid/
   unavailable state, and exposes full download only with permission; no body enters
   Realtime/analytics/audit/logs.
3. Archive returns entry list only; zip-slip, zip bomb, corrupt/password/limit cases return
   typed unavailable states and leave no extracted Drive/local residue.
4. Landing internal links navigate inside a sandboxed dedicated origin. Test scripts/forms/
   popups/top navigation/network calls and attempts to reach Wishly/session/local APIs: all
   blocked. Screenshot fallback remains usable.

**Pass**: ≥95/100 attempts reach the useful milestone in 3 s; every remainder shows explicit
wait/typed error by 3 s; zero false-ready states, and team HTML cannot read or act as user.

### V7 — Upload, Range download, conflicts and trash (User Story 5, SC-007)

1. Upload >5 MiB through a resumable session; interrupt after a chunk, query received Range,
   resume on a 256 KiB boundary, finalize once.
2. Retry start/finalize with the same idempotency key: one Drive file/operation/material.
3. Race two same-name uploads: reservation forces explicit keep-both/replace/cancel; replace
   binds the exact chosen file id.
4. Verify preview/download Range response is 206 with correct headers and max 32 MiB.
   Browser full download >100 MiB returns `AGENT_REQUIRED`; agent assembles safely.
5. Trash uses `trashed:true`, never permanent delete; restore when `canUntrash`; display the
   current Drive recovery limit and inability to guarantee recovery after direct purge.
6. Simulate “Drive succeeded, DB finalize failed”; retry/sync reconciles without a second file.
7. Edit an eligible complete UTF-8 `.txt`: require `view+edit`, live `canModifyContent`, and
   expected Drive identity; stale identity returns `SOURCE_CHANGED` without a write. Confirm
   SRT/VTT, invalid/truncated/over-limit text and the existing read-only transcript modal do
   not expose direct edit.
8. Create a new version with `upload`: distinct file/material, explicit conflict handling,
   inherited metadata, one acyclic `version_of` predecessor and unchanged source. Retry with
   the same key creates one file/link. Exact replacement remains separate and requires
   `upload+edit` plus confirmation.
9. Run the controlled 100-action matrix: 20 each upload/download/rename/move/trash, balanced
   across My/Shared Drive and documented size buckets; repeat typed failures with the same
   idempotency key.

**Pass**: ≥95/100 qualify on first attempt or converge safely on retry; all 100 have zero
loss, duplicate, wrong-target mutation, silent overwrite, or false completion.

### V8 — Process and return derivative (User Story 5, SC-008)

1. Begin process and inspect grants: scoped to actor/team/source/tool/destination/operation,
   hashed in DB, short-lived, absent from logs.
2. Agent downloads bounded ranges, runs existing tool/SSE, uploads via resumable session and
   finalizes a separate derivative with inherited metadata/provenance.
3. Cancel during download, tool execution and upload; verify temp cleanup and truthful state.
4. Remove permission before next range/session/finalize: new step denied; an already-issued
   upload may finish only that bound operation.
5. Retry failure/idempotency: never two successful derivatives for one operation key.
6. Moderate 20 pilot media buyers on one uninterrupted first attempt; facilitator help or
   manual restart fails, while internal idempotent retries may remain within the attempt.

**Pass**: at least 18/20 complete find→preview→process→return unaided; original remains intact
and provenance is committed.

### V9 — Realtime, audit and success metrics (SC-001, SC-005, SC-009)

1. Cloud operation changes arrive through RLS-filtered Postgres Changes; reconnect triggers
   authoritative refetch. Local fine progress remains agent SSE; no polling.
2. Removed member cannot authorize/refetch team rows. Realtime payload contains no token,
   grant, file content/name where unnecessary, transcript or audit target.
3. Verify critical membership/role/connection/trash/process events are append-only and
   owner/admin-readable.
4. Typed analytics capture opaque study/flow/attempt ids, durations, category/cue/action,
   cache/storage/size bucket, attempt number, outcome/retryability, assistance, workspace
   session, discovery and production completion. They exclude query/target/file/path/Drive/
   email/metadata values, content and secrets.
5. Run the read-only aggregate for four team-relative seven-day windows from root connection.
   A denominator team-week has pilot enrollment, ≥2 active members at window start,
   non-detached root, and a workspace session. Numerator has both discovery and production in
   that week. Return numerator/denominator/rate and pass/fail/insufficient; never average a
   weak week away or use ad-hoc production SQL.

**Pass**: four-week pilot activation can be measured without ad-hoc production SQL.

## Planned automated coverage

| Test                                                         | Primary proof                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `tests/team-contract.test.ts`                                | rebuild/stale-dist, shared/SQL/version/classifier parity         |
| `supabase/tests/database/team-workspace.test.sql`            | all-function definer/ACL/search-path, RLS/domain invariants      |
| `tests/drive-connect.test.ts`                                | OAuth mode/state/token/root and zero-side-effect gates           |
| `tests/drive-ops-guard.test.ts`                              | ancestry, shortcuts, capabilities, conflict/idempotency          |
| `tests/drive-transfer.test.ts`                               | scoped grants, 206 Range bounds, resumable finalize              |
| `tests/material-category.test.ts`                            | canonical MIME/extension/package classification                  |
| `tests/transcript-ingestion.test.ts`                         | UTF-8/cue extraction, bounds, version/tombstone behavior         |
| `tests/catalog-search.test.ts` / `catalog-benchmark.test.ts` | no-leak search and 50k application benchmark                     |
| `tests/catalog-sync.test.ts`                                 | durable resume/replay/lease/ingestion/reconciliation             |
| `tests/team-preview-sandbox.test.tsx`                        | media states, archive bounds, isolated navigable landing         |
| `tests/team-bridge.test.ts`                                  | scoped transfer, existing tool reuse, cancel/cleanup/result      |
| `tests/team-file-operations.test.tsx`                        | permission split, TXT edit, version lineage/conflicts            |
| `tests/team-workspace.test.tsx`                              | route/context/API/Realtime/SSE composition and UX states         |
| `tests/analytics-queries.test.ts` / `analytics-cli.test.ts`  | four-window aggregate denominators and stable read-only envelope |

## Local implementation evidence — 2026-08-01

Environment: macOS development workspace, Node 22 project toolchain, local Supabase CLI
stack with PostgreSQL 17 migrations rebuilt from an empty database. No production project,
provider account, deployment, release, or user data was changed.

- V2 automated authority/delivery subset: `tests/team-invitations.test.ts`,
  `tests/team-workspace.test.tsx`, and the US1 pgTAP cases pass. This proves atomic owner
  creation, canonical/deduplicated invitations, identity/expiry/capacity enforcement,
  persisted delivery failure, token rotation/revoke, switching, and hidden-team UI
  isolation. The separate moderated SC-001 cohort remains unexecuted and is not represented
  as evidence here.
- V3: `tests/team-members.test.tsx`, `tests/delete-account-team.test.ts`, and the US2 pgTAP
  cases pass. The complete database suite now contains 234 assertions and proves independent
  `edit`/`manage_metadata` overrides, next-action reads, serialized transfer/removal with one
  owner, transfer-grant revocation, owner/admin-only audit reads, and owner deletion
  preflight. The deletion Edge function also bundled and returned a 204 CORS preflight in
  the local runtime.
- V4 automated OAuth/root subset: `tests/drive-connect.test.ts` passes its complete closed
  mode/origin matrix, state/PKCE replay, refresh-token omission/`invalid_grant`, My Drive and
  Shared Drive flags, root confirmation/replacement/detach, and initial-sync enqueue smoke
  cases. Live provider-account exercises in V4 steps 4–9 remain external validation.
- V5 automated catalog subset: the six US3 Vitest files pass 34 assertions, and the complete
  local pgTAP run passes 234 assertions, including an exactly-50,000-row visible PostgreSQL
  fixture plus 137 hidden-team rows, caller/team isolation, metadata-only writes, conditional
  transcript commits, tombstones, durable provenance, indexes, ACL inventory, and the one
  named Cron schedule. The catalog Edge worker bundled in the local runtime and rejected a
  request without its named secret with `AUTH_REQUIRED`.
- The deterministic application workload used fixture hash
  `116a619362c3ddcb393cca9ce999ccbd161a8d20f80a217858586b742f8ec42e` and query-manifest
  hash `87cece125fb4d66383287fbd4496dd795cacc8ad8ffef02730767de012bd23e4`.
  Across 3 × (20 warmups + 100 searches + 100 filter changes), milliseconds were: overall
  p50 1.362 / p95 1.773 / p99 1.992 / max 3.020; search p50 1.411 / p95 1.862 /
  p99 2.105 / max 3.020; filter p50 1.273 / p95 1.578 / p99 1.745 / max 1.966.
  This is repeatable local adapter evidence, not a substitute for the specified dedicated
  4-vCPU/8-GiB authenticated PostgreSQL environment. That formal run and the 20-person
  balanced-cue SC-005 cohort remain unexecuted, so T079 stays open.
- V6 automated preview subset: `tests/drive-transfer.test.ts`,
  `tests/team-preview-sandbox.test.tsx`, and `tests/team-preview-ui.test.tsx` pass. They prove
  bounded Range responses and grants, explicit media states, archive limits, landing-package
  navigation on the isolated origin, sandbox restrictions, fallback behavior, and old-agent
  blocking limited to Team Workspace. The controlled 100-attempt network matrix has not been
  run, so T091 stays open.
- V7/V8 automated file and process subset: `tests/drive-ops-guard.test.ts`,
  `tests/drive-transfer.test.ts`, `tests/team-bridge.test.ts`,
  `tests/team-file-operations.test.tsx`, the transcript regression, and the operation pgTAP
  cases pass. They cover live ancestry/capability guards, resumable transfer, scoped grants,
  exact conflicts, TXT preconditions, version/provenance invariants, trash/restore,
  permission loss, cancellation/cleanup, one-result idempotency, authoritative Realtime plus
  local SSE progress, and large agent downloads. The SC-007 100-action provider matrix and
  SC-008 20-person pilot remain unexecuted, so T113 stays open.
- V9 implementation and privacy subset: typed runtime workspace/file/workflow events feed a
  content-free, read-only `team-workspace --period ... --json` aggregate. Analytics query/CLI,
  UI emission, adversarial log/error/audit/Realtime payload, and recursively discovered EN/UK
  translation-key tests pass. The four production team-week denominators were not queried;
  that external measurement remains part of T123.
- The production configuration source pins `DRIVE_OAUTH_MODE=verified` and the shared
  canonical origin. An inert public-key fixture passes `scripts/verify-web-env.mjs`. The
  already-published signed stable manifest was intentionally not changed, packaged, or
  released; the complete publication gate must continue to reject it until the normal release
  process publishes a manifest advertising the Team Workspace contract.

Final local gate results:

- `npm run generate:team-contract -- --check`: passed after rebuilding shared output.
- `npm run format:check` and `npm run lint`: passed.
- `npm test`: 102 files and 651 tests passed; 3 manual files / 6 tests were explicitly skipped.
- `npm run test:team`: 18 files and 147 tests passed.
- `npm run test:db`: 2 pgTAP files and 234 assertions passed against the isolated local stack.
- Shared, web, and agent builds passed. Vite reported only its non-failing >500 kB chunk
  advisory.
- `npm run test:agent:e2e`: passed against release candidate `0.9.0+36` / API 5. A legacy contract got
  `AGENT_UPDATE_REQUIRED` only for Team Workspace while existing tools remained compatible;
  Optimal, Custom, and Embedded real media jobs completed and left every source unchanged.

Locally implementable work is covered by these gates. T051, T079, T091, T113, and T123 stay
open because their remaining acceptance evidence requires moderated participants, live
My/Shared Drive fixtures, controlled network/hardware conditions, or production-relative
analytics windows.

### Release decision — 2026-08-01

The product owner authorized the `0.9.0` release and production deployment after all automated
contract, unit, integration, pgTAP, build, privacy, and real-agent gates passed. The owner will
perform the remaining moderated cohorts and live-provider/network matrices after deployment.
No SC-001/SC-005/SC-006/SC-007/SC-008/SC-009 result is inferred or fabricated by this release
decision; T051, T079, T091, T113, and T123 remain post-release validation items until their
specified samples and evidence are recorded.

Commands used for this evidence:

```bash
npx supabase db reset
npx supabase test db supabase/tests/database/team-workspace.test.sql
npx vitest run tests/team-invitations.test.ts tests/drive-connect.test.ts tests/team-workspace.test.tsx
npx vitest run tests/team-members.test.tsx tests/delete-account-team.test.ts
npm run build -w @video-compressor/shared
npx vitest run tests/material-category.test.ts tests/transcript-ingestion.test.ts tests/catalog-search.test.ts tests/catalog-sync.test.ts tests/catalog-benchmark.test.ts tests/team-catalog.test.tsx
npm run generate:team-contract -- --check
npm run format:check
npm run lint
npm test
npm run test:team
npm run test:db
npm run build
npm run test:agent:e2e
VITE_SUPABASE_URL=https://example.supabase.co \
  VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_fixture \
VITE_SITE_URL=https://wishly-app.pages.dev \
  node scripts/verify-web-env.mjs
```

### Production provider follow-up — 2026-08-02

- Google Drive API is enabled, the production Edge callback is registered, and the broad
  `drive` scope is configured as a restricted scope. On 2026-08-02 the OAuth app was
  explicitly published and Google reports `In production`. Publication is not restricted-
  scope approval, so production `DRIVE_OAUTH_MODE` remains `disabled`; no unverified mode was
  labelled `verified` and no production Drive operation was attempted.
- The first branding verification run reported four concrete issues: the live home page
  resolves to sign-in, the public purpose was not visible there, the page name could not be
  matched to `Wishly`, and the uploaded PNG had incorrect padding. The PNG was regenerated
  from the canonical Wishly SVG and saved in Google. A public bilingual Wishly home page with
  purpose, Google Drive use, privacy and legal links is implemented and validated locally.
  Commit `44d7458` is pushed and deployed to the isolated Cloudflare preview alias
  `https://oauth-review.wishly-app.pages.dev`, and that alias is saved as the OAuth home page
  without bypassing the production provider gate. A second branding verification was
  submitted, but Google still reported that the branding was not being shown. Cloudflare's
  preview-only `noindex` response was then explicitly overridden for `/`; deployment
  `9d581d59` from commit `e2e9d1d` now returns `X-Robots-Tag: index, follow`. A verification
  run against that corrected response remains pending, so restricted-scope approval is not
  claimed.
- The Google OAuth client credentials and a new Resend API key are stored only in the
  Supabase secret store. Resend has no verified sending domain because the Cloudflare
  account currently has zero zones or custom Pages domains. `INVITE_EMAIL_FROM` therefore
  remains unset instead of claiming that the Resend test sender is production-ready.
- The deployed provider-readiness endpoint reports `production=true`, `oauthMode=disabled`,
  Google Drive unavailable, invitation email unavailable, and the catalog worker available.
  `npm run verify:team-production` correctly stops at this state.
- The live Team Workspace route at `https://wishly-app.pages.dev/team` renders the team,
  member/invitation management, Drive connection panel, audit history, and catalog. The
  visible launcher hotfix is committed and pushed, but the latest production Pages
  deployment still identifies release commit `8147fb7`; the readiness gate correctly blocks
  deploying the hotfix until the provider state above is truthful.
- Fresh automated gates passed: contract generation check, formatting, lint, 150 Team
  Workspace tests in 19 files, 234 pgTAP assertions, 657 full-suite tests in 104 files (with
  the same 6 explicitly manual tests skipped), the web/agent builds, and the real-agent E2E
  check for `0.9.0+36` / API 5.
- The read-only production analytics command
  `npm run analytics -- team-workspace --period all --json` returned one SC-001 attempt with
  zero successes, four SC-005 attempts with zero successes, and four SC-009 windows with
  zero denominators. All three results are explicitly `insufficient`; no success criterion
  or remaining task is inferred from them.

T051, T079, T091, T113, and T123 remain open until their real participant, controlled
network, live My/Shared Drive, dedicated benchmark, and four qualifying production-window
samples exist. This follow-up records actual readiness and measurements without fabricating
those samples.

### Temporary direct-member implementation evidence — 2026-08-02

- `npx supabase db reset` rebuilt PostgreSQL 17 from empty state through
  `20260802100000_team_direct_member_testing.sql`; `npm run test:db` passed both files and
  244 assertions. The new cases prove service-only ACL, caller permission recheck, exact
  confirmed-account matching, pending-invite closure, duplicate rejection, member-51
  rejection, atomic audit, and no membership for unknown/unconfirmed accounts.
- Failing-first Edge and UI cases in `tests/team-invitations.test.ts` and
  `tests/team-direct-member.test.tsx` now pass. They prove disabled mode performs no RPC,
  lookup precedes the service mutation, delivery/token functions are not called, the member
  list refreshes, and the unknown-account message is explicit. Readiness/config tests prove
  unknown values fail closed and distinguish `direct_add_testing` from full provider ready.
- `npm run generate:team-contract:check`, migration validation, `npm run format:check`,
  `npm run lint`, and `scripts/verify-web-env.mjs` passed. The Edge runtime bundled all
  functions successfully with the new command.
- `npm test` passed 105 files / 663 tests; the same 3 manual files / 6 tests remain explicitly
  skipped. Shared, web, and agent builds passed with only Vite's existing non-failing chunk
  advisory. `npm run test:agent:e2e` passed for `0.9.0+36` / API 5 and left all source media
  unchanged.
- Before enabling the pilot secret, `npm run verify:team-production` correctly failed on the
  absent `INVITE_EMAIL_FROM`; no readiness was fabricated. The deployment record is added
  only after the server secret, migration, functions, web build, and live endpoint are
  actually verified.
- With explicit owner authorization, `TEAM_DIRECT_ADD_MODE=testing` was set in the Supabase
  secret store, migration `20260802100000` was applied to the linked Wishly project, and
  `team-invitations` v7 plus `drive-connect` v8 were deployed active with JWT verification.
  `npm run verify:team-member-pilot` then passed against the live production-origin readiness
  endpoint while the strict full-provider check continued to report the truthful
  `oauthMode=disabled`, unavailable Google Drive, and unavailable invitation email.
- Functional commits `8e58e18` and `0382cf7` were pushed to `origin/main`. The scoped
  `npm run deploy:web:member-pilot` gate passed release compatibility and published Cloudflare
  Pages production deployment `1b0effc2-0753-4b36-b030-6150d5089fc7` from source `0382cf7`.
  The canonical site serves the new `index-CsEB5el0.js` and
  `ProtectedWishly-HBYoCI26.js` bundles; live bundle inspection found the labelled registered-
  email copy and `direct-add` action. An unauthenticated direct-add request returned structured
  `AUTH_REQUIRED` HTTP 401, and the remote migration list contains `20260802100000` on both
  sides. No synthetic production user, team, membership, Drive object, Agent release, or tag
  was created during smoke verification.
