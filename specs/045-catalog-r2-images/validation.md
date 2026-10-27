# Implementation validation — 045

Status: functional implementation complete; final full `npm run verify` passed14/14 gates with7989passed tests and45explicit skips (8034total). Real R2, hosted runtime and packaged-beta acceptance remain unverified. Imports are disabled by default; no production changes were performed.

## Delivered behavior

- Local drag/drop and Google Drive folder import, explicit Analyze and upload, bounded manifests/uploads, resume/retry/cancel and verified R2 publication.
- Filename garment/color matching; ordinary names remain successful random images. Catalogs reuse the URL dictionary without re-uploading immutable images.
- Human help explains clothing, mixed attributes, filenames and random behavior; one-click copy exposes the complete unbranded1:1 generation prompt.
- Standalone creation, Launch and updater use the new image contract. Migration1550 reserves a future child UUID before video restitch; frozen selection, issued uses and the child share that identity. Preexisting acceptedv1 generations/checkpoints remain compatible after team cutover.
- Current permission, actor, archive and parent-state checks apply before memoized resources are returned. Revocation and retained-row identity guards protect external catalog writes.
- Privacy-safe diagnostic producers, authoritative projections, CLI diagnosis and explicit missing evidence.

## Executed checks

| Check                                                                             | Actual result                                                                                                   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Final targeted SQL, Launch readiness/execution/durable, budget and finance timing | 56/56 passed across6suites; includes6actual PGlite SQL cases                                                    |
| Canonical disposable PostgreSQL chain + pgTAP                                     | 41files,976assertions passed                                                                                    |
| Native Auth/concurrency/retention                                                 | 2Auth +31native tests passed, including4R2publication/adoption/deletion races                                   |
| Final public database types                                                       | Generated from the owned schema-only clone using Supabase CLI2.122.0; formatted, no hand-edited generated types |
| Fresh web build after Launch fix                                                  | Passed                                                                                                          |
| Earlier scoped release build / end-to-end gates                                   | 5/5build gates;8/8build+DB+a11y+CSP gates passed                                                                |
| Deno2.5.6 function entry and pinned lock                                          | Passed; aws4fetch1.0.20, supabase-js2.110.7                                                                     |
| Full `nice -n 15 env SOTY_VERIFY_SERIAL=1 npm run verify`                         | Passed14/14gates;7989passed,45explicit skips (8034total);2283seconds                                            |
| Production environment gate                                                       | Not passed: deployment environment values are absent in this isolated worktree                                  |

The native run preceded the final memoized-authority guard. That guard and its edit-loss/archive/cancellation cases were subsequently verified in the6-case actual PGlite SQL suite. The temporary type-generation runner and its disposable clone were removed. No source application rows, source passwords or scheduled job execution were copied.

Commands for the final focused batch:

```sh
nice -n 15 npx vitest run tests/team-accounts-unified-finance.test.tsx tests/catalog-image-launch-resources.test.ts tests/launch-catalog-preparation.test.ts tests/launch-catalog-execution.test.ts tests/launch-catalog.test.ts tests/performance-budgets.test.ts --maxWorkers=1
```

The final full run includes the final memoized-authority guard and its sixth SQL regression. Earlier full runs found genuine contract/integration failures and one unrelated finance-test timing race. Each was repaired. The finance assertion now waits for the existing post-commit microtask signal while retaining its exact four-phase chain, correlation and privacy assertions; no production finance behavior or timeout was changed. Earlier failures are archived, not counted as passes.

## Independent review

The storage and integration reviewers reached98/100 in their explicitly stated independent slices. The final1550 follow-up initially fell to97 for missing current-authority validation on the memoized branch, then returned to98 after the fix and real SQL regression were reviewed. Its initially suggested public bypass was corrected:the dispatcher already rejects reserved Launch keys. The guard strengthens contract parity and defense in depth. Review scores do not attest actual R2/provider behavior.

[Storage review](reviews/implementation-storage.md), [integration review](reviews/implementation-integration.md).

## Bounded performance allocation

The owner instructed us to prioritize the catalog feature over16KB savings. The unchanged old entry/largest/Accounts ratchets remain enforced. Shared/existing growth is separately limited to20,000gzip bytes against the exact clean base, and the complete Launch graph is capped at45,000bytes. Fresh budget tests pass. [Measured comparison](bundle-budget-comparison.json). Neither esbuild nor Terser probes was adopted; dependencies and minifier settings are unchanged.

The offline50MB Deno reference found and repaired an SDK body-copy defect:peak RSS fell from315MB to about169MB; final local CPU437ms. The signer receives metadata/verified digest and length only; bounded views of the same buffer carry publication bytes and abort signals are restored at fetch boundaries. [Benchmark](benchmark-local.ts), [result](benchmark-local-result.json). This is synthetic transport, not hosted aggregate-isolate acceptance.

## Actual provider setup — 2026-10-27

The owner completed R2 payment/activation in Chrome. The earlier API10042 activation blocker is resolved. Created and verified two empty Standard buckets in automatic EEUR: `soty-catalog-images-beta-staging` and `soty-catalog-images-beta-public`. Both currently remain private and have r2.dev disabled. Staging has an enabled one-day object expiry backstop and exact PUT/Content-Type CORS for `http://127.0.0.1:5175` and `http://127.0.0.1:43140` (300-second preflight max age). No expiry was added to the public bucket.

The following active rules match only `catalog-images-beta.soty.pp.ua`:

- Response Header Transform `a63bf20715c14e0c83c51c3a253c2cb9`: set `X-Content-Type-Options: nosniff`.
- Cache Rule `66d7112008f9483faac519273db98f65`: eligible for caching, respect an existing origin Cache-Control header, otherwise bypass; status codes >=400 use No store. Positive object metadata supplies the immutable one-year TTL. This matches [Cloudflare's documented settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/); actual HTTP/CDN behavior still needs verification.

Prepared, but not submitted: custom domain attachment with TLS >=1.2; a 24-hour Object Read & Write account token restricted to these two beta buckets; and a separate Cache Purge token for only the `soty.pp.ua` zone, expiring 2026-10-28 17:35 UTC. Cloudflare's purge permission covers the zone, not just the beta hostname. Browser action-time confirmation for credentials/public exposure is pending; no token was created and no custom-domain DNS record was submitted. An ignored local mode0600 beta configuration contains non-secret targets and empty credential slots; import activation remains false.

`provider-acceptance.ts` is prepared and passes Deno2.5.6 type checking. It refuses other targets, uses only synthetic existing PNG/JPEG/WebP fixtures and fresh UUIDs, redacts provider/fetch errors, tests HTTP preflight/presign/signed MIME/public-path denial/conditional PUT/replay/anonymous byte+MIME+nosniff reads/CDN caching, and cleans only its own synthetic objects with origin and CDN readback. It has **not run against R2** and explicitly excludes browser enforcement, hosted gateway/isolate, DB races and importer acceptance.

Two independent static harness reviews reached98/100 after fixing incomplete CORS assertions, CDN-only replay verification, unchecked cache HIT payloads, and coupled cleanup. Staging/public cleanup now run independently; a private ignored0700 directory and atomic0600 ledger retain only allocated synthetic UUID identities before provider writes and prevent a new run from ignoring an earlier unknown outcome. Cleanup continues after a ledger-update failure. Every ordinary positive/HIT response is checked for exact fixture bytes/MIME/nosniff; replay is verified at origin and CDN and described only as an unexpired observation. URL denial after expiry is explicitly unproven. Final Deno2.5.6 check, Prettier and git diff checks pass. These review scores attest only script quality, not a live provider/product result.

Actual isolated R2 behavior, secret-only hosted gateway/cron, late writes, hosted aggregate resources and25k/1000-file scale still require acceptance. Packaged beta/old clients/macOS+Windows and actual external feed importer remain unverified. Keep global/team import flags off until these pass; this feature requires a full release. No production app/database deployment or production catalog mutation was performed.

## Isolation and diagnosis

Base:b0c0077b6b95f43f54daa32912052e2e7a7e953a. Branch:045-catalog-r2-images. Worktree:/Users/daynero/RiderProjects/AffSupport-045-r2-images. Original dirty044/046/account work was not modified. All applied earlier migrations remain unchanged; new045migrations run500–1550.

The read-only analytics CLI was used to inspect production errors and bounded catalog/Launch evidence. Sampled updates and one sampled current Launch had verified success; this does not establish the cause of every reported creation failure. Raw diagnostic output stayed outside the repository. No production fix or deployment is claimed.

[Archived checkpoints](reviews/implementation-history.md) retain earlier commands, failures, isolation snapshot and browser component smoke scope.
