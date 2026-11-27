# Provider research: independent recovery for R2 workspaces

**Researched:** 2026-11-14. **Status:** design recommendation; no resources provisioned, no live configuration changed. Prices below are public list prices, not an account-specific quote. Recheck before procurement and release. USD unless stated otherwise; taxes, FX, support and payment processing are additional.

## Decision

Use **Cloudflare R2 Standard as primary** and **Backblaze B2 pay-as-you-go as the independent recovery copy**. Provision new primary buckets with the **EU jurisdiction restriction**, and the B2 account in **US East (Reston, Virginia)**. This is a geographically disjoint configuration: EU and US cannot describe the same country. Separate providers reduce vendor-wide failure coupling. Neither choice proves that simultaneous failures are impossible.

This choice intentionally introduces storage in the US. The product must disclose the backup region and resolve applicable contractual/data-transfer requirements before onboarding data into this topology. Do not market it as EU-only. If EU-only storage becomes a product requirement, do not silently swap B2 to Amsterdam and claim proven country separation: R2 does not expose a guaranteed individual EU country. Obtain a country-specific primary placement commitment or choose another qualified topology. This is a production qualification gate, not a reason to leave the planning architecture undecided.

**Why B2:** no minimum file size or duration charges, predictable storage, ordinary S3 operations without transaction charges, explicit regions, and immutable retention. Its direct-download allowance permits recovery without making Cloudflare part of the emergency path. A second R2 bucket is useful for some mistakes but is not this independent backup.

## Verified provider facts and alternatives

| Provider               | Current public storage price                                                                                                      | Reads/writes/transfer                                                              | Constraint relevant to Soty                                                                             | Decision                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| R2 Standard            | $0.015/GB-month                                                                                                                   | Class A $4.50/million; Class B $0.36/million; direct egress free                   | Other services such as Workers can charge separately; per-billing-unit rounding applies                 | Primary                                                                                                    |
| Backblaze B2           | $6.95/TB/30 days, byte-hour metering                                                                                              | A/B/C calls free; egress up to 3× monthly average stored bytes free, then $0.01/GB | No minimum file size/duration; Class D outbound notifications remain metered                            | Preferred independent copy                                                                                 |
| Wasabi pay-as-you-go   | $7.99/TB/month                                                                                                                    | API/ingress free; free egress subject to active-storage-based policy               | 1 TB account minimum and 90-day minimum duration; frequent replacement/deletion incurs retained billing | Alternative for stable archives, weaker fit for changing workspaces and emergency download spikes          |
| Hetzner Object Storage | Current page exposes €0.0104/hour base, but dynamic price fields omitted the monthly cap and overage values in the retrieved page | Page confirms free S3 API/ingress and a base storage/egress allowance              | 64 KB minimum billed object; no built-in cross-location replication; DE/FI locations                    | Candidate for an EU-only alternative, **not financially qualified from incomplete current price evidence** |

Sources: [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [B2 pricing](https://www.backblaze.com/cloud-storage/pricing), [B2 transaction classes](https://www.backblaze.com/cloud-storage/transaction-pricing), [Wasabi 2026 pricing](https://docs.wasabi.com/docs/may-2026-wasabi-pricing-faqs), [Wasabi product terms](https://wasabi.com/product-terms), [Hetzner product/pricing](https://www.hetzner.com/storage/object-storage/), [Hetzner replication FAQ](https://docs.hetzner.com/storage/object-storage/faq/general/).

Do not reuse older $6/TB B2, $6.99/TB Wasabi or €4.99/month Hetzner assumptions. B2's new rate and free A/B/C calls took effect May 1, 2026; Wasabi's updated price applies to existing pay-go billing from July 1, 2026. The Hetzner 2024 launch announcement is historical evidence, not a current quote. [B2 announcement](https://www.backblaze.com/blog/backblaze-pricing-and-product-updates/)

R2 Infrequent Access is **not** the default: retrieval is billed, requests cost more, and minimum duration changes the economics of active/changed material. A future archive tier must be separately modeled rather than advertised as a free optimization. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

### Geography and retention

R2 location hints are best effort. A jurisdiction restriction is a storage-location guarantee at jurisdiction granularity and cannot be changed after bucket creation. Use an EU-jurisdiction endpoint/configuration consistently, including administrative tools. [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)

B2 assigns the account to one region at creation; moving regions needs another account. US East is Reston, EU Central is Amsterdam, and Canada East is Toronto. A new region account must have independent scoped credentials and monitored billing. B2's native Cloud Replication is B2-to-B2; it does not automatically mirror R2. Soty needs its own durable transfer/verification pipeline. [B2 regions](https://www.backblaze.com/docs/cloud-storage-data-regions), [B2 Cloud Replication](https://help.backblaze.com/hc/en-us/articles/5070580424859-Cross-Region-Cloud-Replication)

B2 Object Lock can protect individual versions. Governance mode can be bypassed by privileged keys; compliance mode cannot be shortened by users. Bucket locking alone is insufficient unless retention actually applies to uploaded files. Configure and verify **30-day immutable backup retention**, distinct from user-visible trash retention, and preserve tombstones in the recovery manifest. Keep live/replication credentials unable to delete backups, shorten retention or administer the account. Emergency retention overrides must never be a normal app capability. Retention must be disclosed because a logical deletion may remain in protected backups until expiry. [B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)

Retention design must also protect old unchanged files. A lock that expired 30 days after the original upload does not protect a six-month-old current version today. Maintain current backup versions with a dedicated retention-only job extending locks to `now + 31 days` at least daily, and alert before the remaining protection drops below 30 days. On replacement/deletion, stop renewal only after the durable tombstone/checkpoint is protected; retain the retired version until the later of its existing lock expiry and `retired_at + 30 days`. This produces a normal **30–31 day** physical-erasure lag for retired backup versions, to be disclosed and tested. The retention job can extend protection but cannot read user content or remove/shorten locks. A prolonged renewal failure invalidates the protection claim and triggers an incident. This is an application policy proposal, not automatic provider behavior.

## Cost model

These are planning calculations, not measurements of Soty's present backend. Use **decimal GB = 10^9 bytes and TB = 1,000 GB** for the customer-facing model. Store exact byte counters and derive invoice conversions using the actual provider billing unit. Validate the first invoice against raw byte-hour/GB-month records; do not silently mix TB and TiB.

Let `U` be average logical user-data GB retained in a month, including any customer-billed history/trash according to the tariff contract. Internal extra copies are not additional user quota consumption. Let `D` be extra previews/derived files as a proportion of U and `V` the extra historical bytes retained only in backup as a proportion of U.

- Primary billed bytes: `P = U × (1 + D)`.
- Secondary billed bytes: `B = U × (1 + D + V)`.
- Storage-only monthly cost: `0.015 × P + 0.00695 × B`.
- R2 operations at scale: `4.50 × A_millions + 0.36 × B_millions` before account-level free allowances/rounding. Count multipart parts, retries, listings, HEAD verification and replication reads; one user upload is not one storage request.
- Direct B2 incident egress: `0.01 × max(0, E_GB − 3 × average_B_GB)`; the allowance is account/month-wide and already-used download traffic consumes it.
- Total cost also includes preview/transcode compute, transfer worker compute/network, database/PITR, standby frontend/API/DNS, monitoring, reconciliation, payment fees, support, fraud, engineering and taxes.

At the baseline `D = 10%`, `V = 30%`, storage costs **$26.23 per average logical TB-month**. This is our modeled arithmetic, not a provider bundle. 30% backup history assumes changed/deleted data retained over the month; it is not a hard upper bound. A workload rewriting all data daily can accumulate roughly 30 extra copies during 30-day retention. Rate limits, version policy and measured churn must prevent an unpriced unlimited-history promise.

| Logical data U | Primary P | Independent backup B | R2 storage | B2 storage | Storage subtotal/month |
| -------------- | --------- | -------------------- | ---------- | ---------- | ---------------------- |
| 100 GB         | 110 GB    | 140 GB               | $1.65      | $0.973     | $2.623                 |
| 500 GB         | 550 GB    | 700 GB               | $8.25      | $4.865     | $13.115                |
| 1 TB           | 1.1 TB    | 1.4 TB               | $16.50     | $9.73      | $26.23                 |
| 5 TB           | 5.5 TB    | 7 TB                 | $82.50     | $48.65     | $131.15                |
| 10 TB          | 11 TB     | 14 TB                | $165.00    | $97.30     | $262.30                |
| 100 TB         | 110 TB    | 140 TB               | $1,650.00  | $973.00    | $2,623.00              |

Free allowances are deliberately omitted from per-customer economics: they apply once at account level, not once per subscription. R2 invoices round billable units upward; the proportional request calculation is an allocation model, not an exact small-account invoice. One million and one Class A operations can incur two billing units before allowance treatment.

### Stress cases and reserves

| Scenario                                                                                           | Incremental/modelled cost                                   | Product implication                                                                                                            |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 20% derivatives + one full extra retained backup copy (`D=.2,V=1`)                                 | $33.29 per logical TB-month storage                         | Recompute margin at this load, not only half-full plans                                                                        |
| 1 TB live, one full rewrite every day, 30 extra retained originals                                 | Approx. $232.65/TB-month storage at `D=.1,V=30`             | Retained churn is a billing risk; enforce documented ingestion/version-generation limits and review custom high-churn accounts |
| 250,000 Class A + 5 million Class B requests per logical TB/month                                  | $2.925/TB allocated request cost, before aggregate rounding | Reasonable scenario only; derive real read/write/object distributions before launch                                            |
| 1 billion uncached R2 Class B operations                                                           | $360 allocated request cost                                 | Egress-free does not mean abuse-free; rate-limit origin, authorize downloads, use bounded caching                              |
| Mature 1.4 TB backup, one complete 1.4 TB restore, no other egress                                 | $0 B2 transfer if allowance remains                         | Restore still incurs worker, destination write, elapsed time and temporary duplicate storage costs                             |
| Brand-new 1.4 TB backup restored immediately                                                       | Reserve up to $14 B2 egress                                 | 3× uses monthly average, not today's peak; do not assume free initial restore                                                  |
| 1 TB logical workspace, 10 TB emergency user downloads + 1.4 TB full restore; mature 1.4 TB backup | `(11.4 − 4.2) × $10 = $72` B2 transfer                      | One outage can exceed a monthly storage bill; include a pooled incident reserve                                                |
| Same emergency volume for 10 TB logical data                                                       | $720 B2 transfer plus infrastructure/operations             | Run a financial incident drill; do not let a provider spend cap silently block recovery                                        |

B2-to-Cloudflare partner transfer can be free beyond the ordinary allowance, but **do not use it in the disaster budget**: an outage of Cloudflare is precisely when that path may be unavailable. A qualified independent CDN partner could lower emergency transfer costs later; its own bill and failure domain must be included.

Initial Drive migration adds temporary overlap. Budget old Drive storage until verification/cutover, new R2+B2 storage, every migration read/write, resumable-transfer workers, preview generation and 20% retry allowance. Do not delete the Drive originals to reduce the migration bill. The storage meter must avoid charging the customer twice for staging and the final object. Inventory must estimate bytes, files, unsupported Google-native documents, change rate and expected copy duration before starting.

Preview compute is a separate unmeasured cost. Use CPU-seconds per input minute/file × quoted CPU rate, capped derivative bytes, concurrency and memory. Benchmark images, PDF, video, HEVC and very small-file populations; do not extrapolate from total GB alone. Do not price plans as only R2+B2 storage.

### Platform fixed costs

Supabase daily backups alone provide a much weaker database recovery point than a 15-minute object replication objective. Published 7-day PITR is approximately **$100/month** ($0.137/hour), on top of the project/compute plan. The official example with Pro, Small compute and credit totals $130/month. Physical/PITR backups are not a portable independent copy, so a separate encrypted export/replay design is still needed. [Supabase backup behavior](https://supabase.com/docs/guides/platform/backups), [PITR pricing example](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery)

For preliminary tariff sizing reserve **$150–$300/month additional shared resilience infrastructure** (PITR + modest independent standby/monitoring/transfer services), with the non-PITR portion explicitly an estimate pending quotes and benchmark. This excludes primary DB growth, customer support, engineering, heavy preview compute and large incidents. At 10 paying accounts it allocates $15–$30/account; at 100 accounts $1.50–$3; at 1,000 accounts $0.15–$0.30. Low early customer count can dominate margin even when storage looks cheap. Do not describe any tariff as profitable until account mix and operational costs are included.

## Recovery architecture recommendation

The following is an architectural proposal inferred from Soty's needs; it is not a statement that the current service already provides these protections.

### A. Independent backup before broad migration

Use immutable per-generation object keys and a transactionally created replication outbox. The transfer worker copies the **exact committed generation**, checks byte count and a full-content checksum (multipart ETag is not a content hash), then records replica identity and verified-at time. Redelivery is idempotent. Bounded retries move failed work to a visible repair queue; compare manifests and object inventories to detect missed events.

Back up the metadata needed to use the bytes: workspace/material/folder identity, versions, catalogs and published pointers, membership/revocation epochs, quota ledgers, migration checkpoints, tombstones, schema/version manifest and encrypted configuration. Keep key recovery outside the failed provider. A bucket full of unnamed blobs is not workspace recovery.

Proposed target: **15-minute RPO** for admitted, normally operating asynchronous replication, measured end-to-end for both objects and recoverable metadata. A success state must distinguish `uploaded` from `independently protected`; do not imply zero data loss for the former. If backlog exceeds the target, expose degradation, alert, and stop admitting new durable mutations if the hard protection limit would be exceeded. A migration is not cut over until its entire selected snapshot and metadata are independently verified, avoiding an initial unprotected workspace.

A 15-minute target is not demonstrated by a daily metadata dump, a queue heartbeat or copying 95% of objects. The recoverable watermark is the oldest dependency across objects **and** metadata. A large object is measured from committed-upload time; admission throttles and full-size load tests must prove that throughput can keep up. Release cannot claim the target until a restore drill has validated it.

### B. Automatic object-read fallback while the control plane is healthy

For a primary storage timeout/5xx, retry within a bounded request budget and fall back to a **verified replica of the same requested generation**. Authorize against current workspace membership and current revocation/deletion state before choosing either backend. Range requests, MIME, Content-Disposition, size/hash and cache semantics remain identical. Do not use stale backup contents to turn an expected 404/revocation into a success; do not let arbitrary upstream failures trigger public access.

This can make a limited R2 storage failure transparent for protected files. It does not survive a total Cloudflare outage if all fallback code still runs in Workers. Nor does it survive unavailable authorization. Provide an explicit unavailable/protection-pending state for recent generations with no verified backup; never return an older generation as though it were the latest.

### C. Independent recovery mode for provider-wide failure

Prepare an independently hosted, version-matched frontend/read API and a separately reachable recovery hostname before the incident. Its authoritative DNS, TLS issuance/renewal, static assets, secrets, monitoring and operational access must not require Cloudflare availability. An emergency hostname under a separate DNS provider is simpler and more testable than claiming that a single Cloudflare-controlled hostname will always switch instantly. DNS caches and already issued URLs mean a hostname switch is not instant.

Proposed recovery objectives, subject to drills:

- **R2-only protected reads:** bounded per-request fallback; aim for p95 within 10 seconds under induced timeout, with primary timeouts and circuit-breaker budgets documented.
- **Cloudflare-wide failure with healthy authoritative DB/auth:** independently hosted read/download service available within **60 minutes** of declared incident; show recovery mode and pause mutations until a deliberately fenced writer is activated.
- **Database/auth outage or metadata corruption:** freeze authenticated file access if current authorization cannot be established; operator-led restore to a separate environment with validation. Initial goal **RTO ≤24 hours** for the qualified launch dataset, with the measured recoverable watermark determining RPO. Never claim 15-minute RPO for this case until independently recoverable metadata proves it.
- **Return to primary:** operator-controlled reconciliation and validation, not automatic bounce-back. Reconcile replication, uploads, deleted/revoked objects, generation pointers and billing before enabling writes.

A read-only recovery path is **warm standby / disaster recovery**, not active-active high availability. It is the recommended first production scope: simpler failure behavior and controlled cost. Full emergency writes require an exclusive externally durable writer epoch/lease, fencing of old writers, conflict-safe idempotency, quota handling, replication back to R2 and failback drills. Do not include these promises implicitly in a “seamless” marketing line.

A stolen primary credential is a distinct disaster: isolate backup credentials/account, protect retention and offline recovery keys, test that the app writer cannot delete/shorten backup versions. A mistaken application deletion is another: propagate a logical tombstone immediately to access policy, preserve a recoverable immutable copy until retention expiry, and ensure restoration does not resurrect access or old memberships.

## Qualification gates before a paid migration launch

1. **Account evidence:** actual primary jurisdiction, B2 account region, endpoint, independent credential boundaries, retention readback, provider billing/quotas and subprocessor disclosures recorded without secrets.
2. **Actual inventory:** original/derived/trash/version bytes, object-size distribution, daily/monthly writes, reads and download bytes, high-percentile churn, tenant concentration, Drive-native exports and source change rate. Label unknown values rather than projecting them from unrelated event counts.
3. **Protection proof:** restore a fresh isolated workspace from B2 and independent metadata, compare complete IDs/counts/hashes/pointers and prove current permissions and tombstones survive. Test empty, small-file-heavy, large-file-heavy and maximum launch capacity datasets.
4. **Fault injection:** R2 5xx, timeout, partial multipart, wrong checksum, missing replica, stale generation, revoked member, deleted object, expired key, replication outage, interrupted migration, total Cloudflare dependency denial, DNS/TLS failure and unavailable Supabase authorization.
5. **Measured objectives:** record copy throughput and backlog drain, effective RPO watermark, first useful read time, total restore time and failback duration; do not substitute provider durability claims for application recovery evidence.
6. **Cost proof:** derive costs from provider meters and measured workloads, including a fresh-account restore and high-churn retention scenario; recompute every tariff at full quota and discounted annual revenue.
7. **Operational readiness:** named incident authority, independent access, tested credentials/key recovery, runbooks, alerts, one-writer fencing and a financial reserve that does not shut down emergency downloads.
8. **Release readiness:** full release/beta gates for the exact shared/agent/backend changes; preview channel alone does not authorize migration of production data. No source deletion and no destructive schema cleanup as part of feature activation.

The choice is therefore **R2 EU + B2 US East, verified asynchronous protection plus transparent healthy-control-plane read fallback and explicit read-only recovery mode**. Active-active writes and EU-only country-guaranteed topology require separately qualified designs; neither is hidden inside the baseline cost or reliability promises.
