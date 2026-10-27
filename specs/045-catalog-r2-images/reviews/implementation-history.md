# Historical implementation checkpoints

This archived log contains earlier in-progress states and superseded verification outcomes. The current verdict is in ../validation.md.

> Current update: owner explicitly prioritized shipping the functional catalog path over16KB optimization. A fixed20KB feature allowance and45KB Launch ceiling are now implemented; targeted performance gates pass. Final full verification awaits the Launch integration fixes below, rather than further minifier experiments.

# Implementation validation — 045

Status: functional Launch integration fixed; final full verifier and the last authority regression are in progress. Budget scope is resolved. Provider/beta/importer acceptance remains unverified; imports disabled by default. No production operations.

## Isolation

Base commit: `b0c0077b6b95f43f54daa32912052e2e7a7e953a`. Dedicated branch `045-catalog-r2-images`, worktree `/Users/daynero/RiderProjects/AffSupport-045-r2-images`. Only feature045 documents copied from original worktree; unrelated dirty source changes excluded. Migration slots 20261206150000 and 20261206151000 reserved after base's existing migration chain.

## Original worktree baseline

```text
 M .specify/feature.json
 M apps/web/src/lib/database.types.ts
 M apps/web/src/locales/en.ts
 M apps/web/src/locales/uk.ts
 M apps/web/src/styles.css
 M apps/web/src/styles/components.css
 M apps/web/src/styles/team-accounts.css
 M apps/web/src/team/accounts/AccountGroup.tsx
 M apps/web/src/team/accounts/AccountSpace.tsx
 M apps/web/src/team/accounts/AgentRow.tsx
 M apps/web/src/team/accounts/useAccounts.ts
 M apps/web/src/team/catalog-updater/CatalogIconControls.tsx
 M apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx
 M apps/web/src/team/catalog-updater/useCatalogUpdater.ts
 M apps/web/src/team/launches/LaunchAccountBrowser.tsx
 M apps/web/src/team/launches/LaunchAccountSelector.tsx
 M apps/web/src/team/launches/LaunchCard.tsx
 M apps/web/src/team/launches/LaunchSession.tsx
 M apps/web/src/team/launches/analytics.ts
 M apps/web/src/team/launches/restitch-runner.ts
 M apps/web/src/team/launches/useLaunchGeneration.ts
 M apps/web/src/team/tasks/TaskAgentTags.tsx
 M coverage-critical.json
 M packages/shared/src/team/account-overview.ts
 M packages/shared/src/team/accounts.ts
 M packages/shared/src/team/index.ts
 M packages/shared/src/team/launches.ts
 M packages/shared/src/team/launches/lifecycle.ts
 M packages/shared/src/team/launches/persistence.ts
 M scripts/analytics/code-map.ts
 M scripts/analytics/coverage-registry.ts
 M scripts/analytics/launches.ts
 M scripts/analytics/queries.ts
 M scripts/analytics/schema.ts
 M scripts/analytics/types.ts
 M specs/035-launches/contracts/generation.md
 M specs/038-unified-accounts/spec.md
 M specs/039-catalog-manager-ux/spec.md
 M supabase/functions/catalog-updater/index.ts
 M supabase/functions/catalog-updater/worker.ts
 M tests/analytics-schema-compat.test.ts
 M tests/catalog-registry-refresh.test.tsx
 M tests/catalog-updater-dialog.test.tsx
 M tests/catalog-updater-worker.test.ts
 M tests/launch-account-selector.test.tsx
 M tests/launch-card-interactions.test.tsx
 M tests/launch-generation-hook.test.tsx
 M tests/launch-restitch-runner.test.ts
 M tests/launch-state.test.ts
 M tests/launch-workspace-ui.test.tsx
 M tests/team-account-accepted-launch.test.ts
 M tests/team-account-social-order.test.tsx
 M tests/team-accounts-contract.test.ts
 M tests/team-accounts-live-finance.test.tsx
 M tests/team-accounts.test.tsx
 M tests/team-catalog-restitch-sql.test.ts
 M tests/team-catalog-updater-sql.test.ts
 M tests/team-task-accounts.test.tsx
 M tests/updater-restitch-routes.test.ts
?? apps/web/src/api/team-agent-release.ts
?? apps/web/src/api/team-launch-assignments.ts
?? apps/web/src/team/accounts/AccountLinkedLaunchRow.tsx
?? apps/web/src/team/accounts/accountsForPeriod.ts
?? apps/web/src/team/launches/LaunchAssignmentControls.tsx
?? packages/shared/src/team/launch-assignment.ts
?? specs/044-current-launch-assignments/
?? specs/045-catalog-r2-images/
?? specs/046-remove-translator/
?? supabase/migrations/20261206148000_launch_current_assignments.sql
?? supabase/migrations/20261206149000_catalog_spare_video_progress.sql
?? tests/account-linked-launch-row.test.tsx
?? tests/catalog-video-readiness.test.tsx
?? tests/launch-assignment-api.test.ts
?? tests/launch-assignment-controls.test.tsx
?? tests/launch-assignment-diagnostics.test.ts
?? tests/launch-current-assignments-db.test.ts
?? tests/support/launch-assignment.ts
?? tests/team-account-period-inventory.test.ts
?? tests/team-agent-release-api.test.ts
?? tests/team-launch-assignment-domain.test.ts
```

## Environment

R2 sandbox credentials/domain and real importer acceptance not yet established. Feature remains disabled until configured; no production subscription, migration or media publication is authorized by this implementation.


## Implementation and local evidence

- User authorized implementation after the reviewed planning package. Work remains on the isolated feature branch; no production action or customer-media access occurred. The new library is disabled by default.
- The implementation includes public R2 publication through private staging, named and normal random classification, local and Drive input, compact dictionary/inventory reads, current-source migration, creation/refresh/growth and durable legacy retries, retention/revocation, prompt/help and agent-readable diagnostics.
- Shared errors have exhaustive web/function maps, an additive generated error-catalog migration (1530) and forward analytics guard update (1540); all applied earlier migrations remain byte-identical.
- Deno 2.5.6 entry-point check and function-local dependency lock passed after the Drive extraction. SDK imports are exact aws4fetch1.0.20 and supabase-js2.110.7. `@ts-self-types` is emitted alongside shared declarations; this resolves the Node/Deno declaration difference without disabling type checks. [Deno reference](https://docs.deno.com/runtime/fundamentals/typescript/).
- Full public database types were generated from the disposable schema-only clone using installed Supabase CLI2.115.0. Intentional nullable `set_launch_offer_defaults.p_expected_version` is now declared in the existing database.compat seam, rather than depending on a hand-adjusted generated type.
- Canonical isolated DB run:41 pgTAP files,968 assertions passed;2 native Auth tests and27 existing native concurrency/retention tests passed. Later feature fixes and the4 new R2 native lock-race tests require the final rerun below. Source stack acceptance036 supplied schema/role identity only, no application rows/passwords. The owned clone and its volumes were removed; schedulers were disabled.
- Targeted final integration batch:118/118 across8 suites, including19 Drive source behavior cases, actual HTTP→SQL→worker→origin/CDN-adapter→dictionary wire, type/color pairing, flags/recovery and UI. Subsequent additive-contract/UI batch:49/49 across4 suites. The full verifier remains pending at this point.
- Early full-verifier failures were repaired: generated-type nullability, two widened test literals, then additive error-catalog and analytics-guard drift. The applied error seed was preserved. Failed results are not counted as passes.
- Cost calculator recomputation exactly matches committed cost-estimate.json.
- Browser component smoke:actual new React component, local fake metadata client, Chrome on macOS, light/dark and folder-picker open/cancel. This found the invalid root material selector and led to allowRoot=false plus regressions. No real provider, upload, user clipboard or production telemetry was exercised; no mobile/Windows/beta/importer pass is inferred. Temporary preview server/files/tab were removed.

## Design refinements verified locally

Eight active uploading/unverified slots per team replace the impractical eight all-unexpired grants. Retired grants remain separately tracked exposure; only trusted terminal work frees active capacity. Temporary pressure is a distinct retryable code; browser retries the same key/generation at5-second intervals, max48 times, abortable, without polling status. True quota failures do not retry. Source input survives a bounded wait failure.

Selections freeze separately for create/growth/refresh. Fresh old-client work is refused before intent creation, with a second atomic DB admission guard; only exact server-owned accepted legacy payloads authorize normalization. Empty admitted v2 pools never fall back to the legacy settings URL. Prewrite and finalization check publication authority; delivered updater reconciliation validates and commits uses atomically with completion.

Drive failures before any file retain a bounded safe cause and explicit retry; cursor/ready entries survive. Realtime receives public revision bumps for private stage transitions. Expiry respects live worker leases, and disabled imports retain discovery/cancellation before first v2 readiness.

## External prerequisites and honest limits

No isolated R2 credentials/custom media domain were present in the workspace/runtime environment inventory. A text question about an existing sandbox was sent; no configuration was supplied. Consequently these remain **unverified**:actual browser CORS/presign/replay/create-only PUT, live nosniff transform and own-CDN purge, hosted secret-only cron, late-write/provider behavior, Edge aggregate memory/CPU at50MB and25k/1000-file scale, packaged beta/old installers/macOS+Windows matrix, and actual external feed importer. Local mocks, HTTP GET shape and review scores do not substitute for these proofs.

The code is not authorized for production activation. Full beta/release is required; web mini is ineligible. Keep global/team import flags off until the documented provider/runtime acceptance passes.


## Resource defect found and repaired

The reproducible offline Deno50MB reference [benchmark-local.ts](../benchmark-local.ts) uses the real pinned AWS signer, actual structural verification and origin/public byte comparison, with synthetic transport and credentials only. Initial peak RSS315,408,384 bytes exceeded the Edge budget; SDK signing a full-buffer Request eagerly copied the payload. The final adapter now signs bounded metadata plus the already verified SHA-256 and Content-Length, then attaches a262,144-byte view stream from that same immutable buffer. It preserves conditional If-None-Match and full origin/public readback; there is no re-copy from mutable staging. Unit regression requires a body-free signing request and exact signed digest/length, and validates sent bytes.

After fix:peak RSS167,182,336 bytes, local process CPU462.889ms, elapsed606.265ms for50,000,000 bytes. [Recorded result](../benchmark-local-result.json). This is a local single-process reference, not hosted Edge aggregate acceptance; T052 remains open for real isolate concurrency and provider I/O.

Latest canonical DB rerun passed41 files/968 pgTAP assertions,2 native Auth tests and31 native tests, including all4 new R2 publication-lock/source/uploader-retention races. Latest publication/validation/wire batch passed28/28; actual JPEG/PNG/WebP, rotated EXIF, animation, size/dimensions, truncated/trailing data and hash vectors use the repository's independently generated fixtures.


## Final implementation refinements and evidence

- Retained rows now receive the same authority check as fresh draws:all outgoing R2 identities are validated before provider write, and guarded completion/reconciliation revalidate atomically. Inactive historical pool membership is allowed; stale revision equality is ignored, but revision must remain a nonnegative safe integer. Actual SQL regressions cover malformed revisions and text-only rounds with no new image uses.
- Pool membership changes have authoritative pool_added/pool_removed journal history and CLI findings. Browser remove/revoke lifecycle proves visible list change only after React commit; it does not claim completed origin/CDN erasure. Large-job explicit reselection reads later bounded pages before deciding whether to resume, preventing a new duplicate job when first100entries are ready.
- A short public-access notice is visible before the upload action; choosing/dropping input alone does not publish.
- Final local50MB reference after signal restoration:peak RSS168,706,048 bytes, CPU436.863ms, elapsed525.972ms. Earlier fixed sample167,182,336 bytes/462.889ms remains recorded for reproducibility. Neither is hosted aggregate-isolate acceptance.
- Targeted batch:305passed,4 native-only skipped with explicit requirement; those4 ran and passed under canonical disposable PostgreSQL. Later schema11passed and public-notice/UI19passed. The new shared critical module measured96.64%lines and90.90%branches in a scoped coverage run; its floor is90, no existing floor lowered.
- Latest schema-only-clone run:41 pgTAP files/970assertions,2 native Auth tests,31 native concurrency/retention tests all passed. It also regenerated final public types. The final small revision-domain condition was then validated by the actual PGlite SQL suite; native ACL/function shape is unchanged.
- Full-suite failures detected and repaired as encountered:additive error/analytics guard drift, missing critical-module registration, expected Realtime subscription inventory, and a test callback lint rule. No skip, timeout increase or lower coverage floor was used to hide a failure.


## Final verification checkpoint

- `nice -n 15 npx vitest run tests/analytics-investigate-command.test.ts --maxWorkers=1`:23/23 passed. The empty-user result explicitly includes unavailable catalog-image projection and four observation limits; it does not report zero failures as proven success.
- Latest UI/schema batch:30/30 passed (19 UI,11 real PGlite SQL), including notice before the legacy publishing action and all retained-row revision cases. The hidden native input remains reachable through its visible picker button.
- Independent last unit shard probe:104 files passed,2 explicitly skipped;895 tests passed,5 explicitly skipped. This probe is not a substitute for the final complete canonical verifier.
- `nice -n 15 env SOTY_VERIFY_SERIAL=1 npm run verify:release -- --gates=build`:5/5 gates passed, including shared/web/agent builds and release/team contract checks.
- `nice -n 15 env SOTY_VERIFY_SERIAL=1 npm run verify:release -- --gates=environment`:blocked by absent VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_SITE_URL, VITE_GOOGLE_PICKER_API_KEY and VITE_GOOGLE_PROJECT_NUMBER. No production configuration was copied or synthesized to bypass this gate. This is not a full release pass.
- Final audit enabled RLS on all14 private operational/diagnostic tables, in addition to the two public client tables, and retained revoked direct grants. Owner-run security-definer paths/views retain their intended boundary. The native pgTAP suite now explicitly inventories all14 RLS flags.
- Both independent scoped reviewers re-read the final changes and retained98/100. Plan now reflects actual mode admission:the first successful verified ready commit under the shared mode lock completes the explicit import action.

- `nice -n 15 env SOTY_VERIFY_SERIAL=1 SOTY_TEST_DB_SOURCE_PROJECT=acceptance036 npm run verify:release -- --gates=e2e`:8/8 gates passed after final RLS/revision changes. This profile rebuilt shared/web/agent, checked release/team contracts, ran the canonical schema-only disposable PostgreSQL suite (including native races and private RLS inventory), then real-browser accessibility and CSP. It completed in218seconds; no production data or configuration was used. The environment gate above remains blocked, so this is not a full release/beta pass.
- Repeated final pinned-runtime command `nice -n 15 npx --yes deno@2.5.6 check --config supabase/functions/catalog-images/deno.json --lock supabase/functions/catalog-images/deno.lock supabase/functions/catalog-images/index.ts`:passed.


## Full verifier and bundle comparison

`nice -n 15 env SOTY_VERIFY_SERIAL=1 npm run verify` passed static gates and the first five unit shards, then failed in shard6 at `tests/performance-budgets.test.ts`:Launch-exclusive44,649gzip bytes exceeds40,000. A direct later shard7 run passed108 files/1108tests, with2 files/11tests explicitly skipped; the earlier shard8 probe passed104 files/895tests, with2 files/5tests explicitly skipped. These separate probes do not turn the failed full verifier green.

A newly created detached worktree at the exact clean base b0c0077b reproduced the same test failure:44,680bytes. The feature adds16,903bytes to total built JS/CSS, and shared/existing accounting rises from998,034 to1,014,952 against the unchanged1,004,788ceiling. The latter limit would also fail once the earlier Launch assertion is resolved. [Machine-readable comparison](../bundle-budget-comparison.json).

The comparison used the same installed dependencies and build command, no environment credentials. Owned throwaway copies compared explicit esbuild and Terser5.51.2 (single worker,3 safe compression passes, property mangling off). Neither improved Launch enough; Terser measured44,818bytes. No minifier change, dependency addition, skipped budget test, raised limit or rewritten baseline was adopted in the feature branch. A package-install experiment altered the throwaway dependency tree; it was discarded and the exact original dependency copies restored before the final Terser measurement.

The owner then explicitly accepted the modest measured feature JavaScript growth and prioritized completing R2 catalog functionality over broader base-route microoptimization. This authorizes a fixed20,000B gzip allowance on shared/existing assets and a45,000B complete Launch-exclusive ceiling, grounded in the measured clean-base44,680B/current44,649B comparison. Entry/largest limits, performance-baseline.json, the original5% ratchet and Accounts accounting remain unchanged. Tests bound both the16,918B feature shared/existing increase against the clean base and total shared/existing against the original ceiling plus the fixed allowance. No asset exclusion, skipped check, minifier or dependency change is used. [Decision and measurements](../bundle-budget-comparison.json). `nice -n 15 npx vitest run tests/performance-budgets.test.ts --maxWorkers=1`:4/4passed against the existing fresh build (979ms total). This targeted pass does not make the earlier failed full verifier green; T051 remains unchecked until the full verifier passes.


## Urgent Launch integration follow-up

A new read of the complete Launch path found missing integration that earlier scoped reviews had not proved:end-user preflight still checked only the Drive pool, and SQL frozen resources still drew Drive images before durable execution. Root now uses an R2-aware readiness function (matched canonical texts, generic text for random pictures, no stale legacy fallback for emptyv2), and server execution uses the persisted generation contract1|2. Storage is adding1550 to reserve the canonical future child identity and freeze/plan R2 resources under that identity, while preserving preexisting accepted-v1 work. Until actual SQL regressions and independent review pass, this path remains in progress; previous98 scores are not asserted for the unfinished follow-up.

Read-only production CLI `errors`, `team-workspace`, `catalog-trends`, `catalog`, `investigate` and `inspect` were used without SQL edits or production writes. A sampled current Launch reached restitch_processing, and sampled earlier catalog updates had verified success; this does not establish the cause of the owner's reported creation failures. No production fix or R2 deployment is claimed. Raw diagnostic output remains outside the repository.


## Final functional follow-up evidence

- Fresh web build passed with the R2-aware Launch preflight. Targeted preparation/executor/resource/budget batch:21/21passed (including5actualSQL cases); prior durable/execution/preparation/timeout batch:36/36passed.
- Canonical schema-only disposable PostgreSQL run with temporary type-generation insertion passed41pgTAPfiles/976assertions,2nativeAuth tests and31native concurrency/retention tests. Supabase CLI actually used2.122.0; final public types were generated from that owned loopback clone. No source rows/passwords copied. The temporary runner was removed. This run preceded the final memoized-authority guard; its new6th PGlite case is rechecked separately.
- Independent1550review reached98/100 after adding current Launch authority before the memoized fast path. The original proposed standalone exploit route was corrected:the dispatcher already rejects reserved launch: keys. The added guard provides contract parity and defense in depth; no public exploit is claimed.
- Read-only provider discovery found an authenticated Cloudflare account, then `wrangler@4.112.0 r2 bucket list` returned API10042:enable R2 through the Dashboard. This is a proven external prerequisite, rather than an inferred missing-secret condition. The owner was given the account Dashboard link while verification continues. No R2 subscription/bucket/token, DNS or production deployment was created.
