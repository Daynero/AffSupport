# Workspace latency investigation — 2026-11-03

## Outcome and limits

The incident was server-side, with a reproducible application-side load
amplifier. It was not limited to one person's Drive or browser. No production
configuration, data, jobs, credentials or deployed application was changed.

The precise resource that first saturated is **not proven**. Memory pressure is
a strong hypothesis; historical CPU, swap activity and blocked-query samples
were not captured during the incident. A full claim that three sign-ins alone
caused the incident, or that a larger instance alone will fix it, is unsupported.

## Observed evidence

Times below are UTC; Kyiv was UTC+2.

- User journeys recorded task reads of 26.127 seconds, member reads of 17.548
  seconds, assignee reads of 16.955 seconds, and two profile refresh failures
  after approximately 10 seconds. Another user's profile read took 5.611 seconds.
  A task read failed with `INVALID_RESPONSE` after 12.512 seconds. This code
  does not establish a malformed response: `throwRpc` also maps unrecognised
  provider errors to it.
- Platform logs recorded 155 `statement timeout` events in the incident window
  around 14:27–14:39. The gateway snapshot covering minutes 14:26–14:39 recorded
  147 HTTP 500 and 21 HTTP 504 responses across the project. These are
  project-wide counts, not counts attributable only to the three new users.
- Cron recorded 33 failed starts around 14:31–14:39, all classified as
  `job startup timeout`, across catalog sync, image processing, recovery,
  maintenance and other jobs. This is distinct from a successfully started
  worker taking too long to process a file.
- At 14:49:42, after the main failure window, the host reported 974,295,040
  bytes RAM, 163,532,800 bytes available, and 615,657,472 bytes of swap used.
  Load averages were 0.17 over one minute and 3.11 over five minutes. Swap
  occupancy alone does not prove ongoing swapping or establish the cause.
- A separate health sample reported 31 backends against `max_connections=60`.
  A later activity sample had no blocked backends. These later samples do not
  exclude earlier connection or lock pressure.
- Cron uses database connections (`cron.use_background_workers=off`), with
  `cron.max_running_jobs=32`. Therefore `max_worker_processes=6` is not the
  direct cron job-slot limit. Startup failures concern connection, command
  submission or startup admission; they are not proof of OS fork failure.
  `shared_buffers` is 256 MiB and `work_mem` approximately 3.4 MiB.
- The history cleaner took 15 seconds at 14:27, 67 seconds at 14:32 and 96
  seconds at 14:37, then 2.46 seconds at 14:42 and under 0.4 seconds afterward.
  Its slowdown tracks the incident. It may be a victim or amplifier; its
  advisory lock is nonblocking and no direct task/member lock chain was found.
- Completed-statement timing statistics were much shorter than the worst
  browser waits: the principal task query averaged 22.8 ms, maximum 1.740 s;
  member query averaged 13.4 ms, maximum 707 ms. A second task query fingerprint
  reached 3.192 s. These counters are cumulative; aborted statements and
  pre-execution queueing cannot be reconstructed from them. Increasing only
  the profile timeout would conceal symptoms rather than establish a repair.
- One user's initial Drive job successfully indexed 375 files in roughly
  6 minutes 37 seconds. Another user's 10-file initial scan was observed in
  `change_replay` without terminal completion. Pending incremental jobs alone
  are not failures, because that worker is recurring.

## Catalog creation before indexing

The application deliberately permits progressive work during indexing.
`SpaceCard` readiness requires a connected Drive, and the creation dialog and
`drive-ops/product-catalog.ts` validate the selected video and settings rather
than waiting for a full-workspace scan. A selected indexed video can therefore
be used while the rest of Drive is still being discovered. No cycle waiting
for completion of the entire index was found in the catalog creation path.

One user's `catalog_manager_template` controls loaded at 14:15:20–21 while the
replacement connection's initial index ran 14:14:25–14:21:02. These were five
settings-editor readback flows, which can start automatically on mount. They
are **not proof of catalog creation, submission, or five deliberate opens**.
The other two bounded timelines contained no catalog-generation evidence.
The third user's completed onboarding at 14:37 followed the first cron startup
failures at 14:31, so that completed connection cannot be their initial trigger.

`catalog team` returns retained update attempts, and actor-scoped
`catalog-trends` counts last-editor observations; neither can establish a
complete inventory of catalog creation attempts. Missing creation evidence
remains explicit. Journey rows are selected by delivery time, so causal
timelines above filter `occurred_at` as well to exclude delayed older events.

During indexing, `WorkspaceShell` also polls explorer/storage state every five
seconds. `useCatalogUpdater` reacts to the general revision and polls every
five seconds while active. These hooks reject stale results but do not cancel
all obsolete in-flight reads. Combined with global revision fan-out, this is
an additional load amplifier. Blocking catalog creation until all indexing
finishes would change intended product behavior and is not yet justified as
the repair.

## Reproduced load amplifier

`useTeamRealtime` funnels catalog-only events into the same `onRefetch` as
membership, tasks and operations. `TeamProvider.handleRealtimeRefetch` increments
the general revision and rereads teams. `useTasks` rereads its task board on
that revision; task member/account directories also depend on it. The shared
handler dispatches an account/finance invalidation as well.

A local jsdom reproduction used the real `TeamProvider`, `useTeamRealtime` and
`useTasks` with mocked network responses. Ten catalog-only notifications spaced
one second apart produced **10 extra task reads and 10 extra team reads in one
mounted client**, with no task mutation. An assertion that an unchanged task
board should not reread failed: expected 1 initial call, observed 11.

This proves unnecessary request fan-out, not that this path alone exhausted the
host. The existing realtime scale test mocks the entire refetch callback and
does not measure this cross-component RPC fan-out.

Temporary reproduction and private diagnostic JSON remain under
`/tmp/soty-lag-investigation/` on the investigation machine, with restricted
permissions. They are not tracked repository artifacts. The failing temporary
test was removed from the normal test suite after recording its output.

## Recommended repair sequence

1. Separate invalidations by data domain. Catalog changes must refresh catalog
   state without invalidating unchanged tasks, member directories or finance.
   Preserve urgent membership loss checks, reconnect catch-up and stale-response
   protection. Add the above reproduction as a regression for the fix.
2. Bound/coalesce in-flight rereads per domain, so a slow reply cannot accumulate
   parallel obsolete requests. Measure actual RPC calls with three clients and
   Drive activity, rather than only a mocked refetch callback.
3. Capture resource history during a recurrence: available memory, swap-in/out,
   CPU and IO waits, connection admission and active blockers. Review cron
   concurrency and the unusually slow history cleaner against that evidence.
   Do not disable cleanup, increase connection limits, restart production or
   upgrade compute without a concrete reviewed action and owner approval.
4. Run packaged-beta acceptance for three simultaneous users performing initial
   Drive sync plus ordinary task/member reads. Require bounded request fan-out,
   no startup/statement timeouts, and measured interactive latency.
5. After release, compare the same CLI diagnostics and user journeys. Do not
   infer success merely from events being emitted or a later healthy snapshot.

## Diagnostic changes

Added `analytics database-performance --json`: bounded read-only statistics,
cron error classification, aggregate provider logs and whitelisted host
metrics. Provider SQL text, parameter values, request paths and log messages
are withheld. Platform log queries follow the documented
[Management API](https://supabase.com/docs/guides/observability/advanced-log-filtering)
and current metrics use the
[metrics endpoint](https://supabase.com/docs/reference/api/v1-scrape-project-metrics).

The existing full `investigate` command refused its output through its privacy
guard during this investigation. The guard was not bypassed. Narrow `journey`,
`sync`, `diagnose` and database commands supplied the evidence above. Repairing
the diagnostic producer/guard mismatch remains separate work.

Validation: the focused database diagnostics and existing realtime tests passed
(23 tests). The full fast verification run was deliberately interrupted during
its eight-shard suite to prioritise this investigation; it is not a complete
suite pass. All 13 static gates passed separately for the final diagnostic changes.
