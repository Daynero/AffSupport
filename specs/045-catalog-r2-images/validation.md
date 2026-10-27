# Implementation validation — 045

Status: functional implementation complete; final full `npm run verify` passed14/14 gates with7989passed tests and45explicit skips (8034total). Actual isolated R2 HTTP/CDN probes passed30/30 and Chrome staging CORS/expiry probes passed9/9. Hosted runtime, full application and packaged-beta acceptance remain unverified. Imports are disabled by default; no production app/database deployment was performed.

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

The owner completed R2 payment/activation in Chrome and confirmed domain/key activation with «перевіряй». The earlier API10042 blocker is resolved. Created and verified Standard buckets in automatic EEUR: `soty-catalog-images-beta-staging` (private) and `soty-catalog-images-beta-public` (published only through the isolated custom domain). Both have r2.dev disabled. Staging has an enabled one-day object expiry backstop and exact PUT/Content-Type CORS for `http://127.0.0.1:5175` and `http://127.0.0.1:43140` (300-second preflight max age). No expiry was added to the public bucket. `catalog-images-beta.soty.pp.ua` is Active/Enabled with minimum TLS1.2.

The following active rules match only `catalog-images-beta.soty.pp.ua`:

- Response Header Transform `a63bf20715c14e0c83c51c3a253c2cb9`: set `X-Content-Type-Options: nosniff`.
- Cache Rule `66d7112008f9483faac519273db98f65`: eligible for caching, respect an existing origin Cache-Control header, otherwise bypass; status codes >=400 use No store. Positive object metadata supplies the immutable one-year TTL. The settings follow [Cloudflare's documentation](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/); actual probes observed negative BYPASS and positive HIT with verified payloads.

Issued a 24-hour Object Read & Write account token restricted to these two beta buckets and a separate Cache Purge token for only the `soty.pp.ua` zone, expiring 2026-10-28 17:35 UTC. Cloudflare's purge permission covers the zone, not just the beta hostname; probes purged only owned synthetic beta URLs. An initial CDN-token value accidentally appeared in technical tool output. It was immediately rolled through Cloudflare's successful rotation flow before use; the replacement was captured without printing it. S3 credentials and the replacement CDN token are stored only in ignored local mode0600 configuration. No credential/grant is in these tracked artifacts. Runtime import activation remains false.

[Actual provider result](provider-result.json): **30/30 passed**, using Deno2.5.6, pinned aws4fetch1.0.20, the actual application adapter and three synthetic PNG/JPEG/WebP fixtures. Passed HTTP CORS allowed/denied preflight, presign upload/readback, signed MIME tamper403, forged public-path403, missing-path negative-cache checks, streamed create-only PUT, conditional overwrite rejection with unchanged origin and anonymous bytes/MIME/nosniff, unexpired staging replay with unchanged final bytes, and verified ordinary CDN HIT delivery. All six staging/public cleanup checks passed, including origin absence and anonymous404 after single-file CDN purge. No recovery identities remain. The first invocation stopped before provider IO because Deno rename also needs read permission on its private journal; the empty journal was inspected/removed and the corrected permissions were used for the successful run.

Two independent static reviews of each harness reached98/100 after recursive fixes. Provider cleanup is independent for staging/public; private ignored0700 directories and atomic0600 ownership ledgers precede provider IO and prevent a rerun from ignoring unknown outcomes. The browser probe additionally serializes mutations, bounds metadata to4096bytes/5seconds and readback to fixture size, and sets browser POST/PUT deadlines. Its actual delivered script blocks for all three modes passed syntax parsing, independently of Deno's TypeScript check. A transient typed-array BodyInit type error was fixed before the actual browser run; the first empty probe server was stopped and restarted, without provider writes. These scores attest harness quality; actual results are the separate recorded runs.

[Actual Chrome result](browser-provider-result.json): **9/9 passed**, three formats in each of three modes. Allowed origin5175: browser PUT succeeded and S3 MIME/bytes matched exactly. Denied origin5176: browser PUT failed, origin was absent, then the same still-live grant succeeded from the server with exact-byte readback (a positive control against a network-outage false pass). Expired grant: after its deadline the browser rejected it, an independent same-grant PUT returned403 and S3 remained absent. Every owned staging object was cleaned; the private recovery directory was removed and the two loopback probe listeners were shut down. These are disposable probe pages, not the authenticated Soty import UI.

Both scripts pass Deno2.5.6 checks. Commands and scoped network/file permissions are documented with the probes; report files contain only bounded sanitized evidence. Screenshots remain local under `/tmp/soty-r2-setup/` (active domain and the three browser verdicts), without credentials or grants.

Still unverified: authenticated Soty import/create/update/Launch against this provider; secret-only hosted gateway/cron, real lost-response/late-write and DB adoption/deletion races; hosted aggregate resources and25k/1000-file scale; packaged beta/old clients/macOS+Windows; actual external feed importer. Anonymous GET format compatibility is proven, Meta acceptance is not. Keep global/team import flags off until remaining gates pass; this feature requires a full release. No production app/database deployment or production catalog mutation was performed.

`nice -n 15 npm run beta:doctor` built shared successfully but stopped at `BETA_ENV_MISSING` (`.env.beta` absent in this isolated checkout). Separate read-only container inventory also found the existing `acceptance036` stack occupying canonical beta ports54321/54322/54324. It was not reused, reset or stopped. Full application/packaged-beta acceptance therefore still needs an available, owned canonical beta environment and its local signing/Functions configuration; actual R2 probes do not replace that gate.

## Isolation and diagnosis

Base:b0c0077b6b95f43f54daa32912052e2e7a7e953a. Branch:045-catalog-r2-images. Worktree:/Users/daynero/RiderProjects/AffSupport-045-r2-images. Original dirty044/046/account work was not modified. All applied earlier migrations remain unchanged; new045migrations run500–1550.

The read-only analytics CLI was used to inspect production errors and bounded catalog/Launch evidence. Sampled updates and one sampled current Launch had verified success; this does not establish the cause of every reported creation failure. Raw diagnostic output stayed outside the repository. No production fix or deployment is claimed.

[Archived checkpoints](reviews/implementation-history.md) retain earlier commands, failures, isolation snapshot and browser component smoke scope.
