# Implementation and acceptance evidence

Work is isolated in `AffSupport-053` / `053-bulk-launches`, based on release source
`2d616995`. The original `AffSupport` checkout stays on `release/1.4.4`; no beta, main,
production version, provider data, release channel or deployment has been changed.
Dependencies belong to this checkout. No active Soty app or other verification was stopped.
All heavy commands use nice 15, sequential gates and one Vitest worker.

## Review / remediation cycles

The two pre-implementation spec/plan/task analysis passes are in `analysis.md`.
Implementation review additionally found and fixed:

1. StrictMode could invalidate a pending preflight; mounted authority is now independent
   from the once-only admission guard. Pending catalog video work prevents a ready card,
   including after page reload. Off-page accepted items are observed using bounded reads
   on the existing list reconciliation cadence. Failed/uncertain admissions retain their
   own state and exact recovery keys.
2. Narrow pending-result layout overflowed the Card grid; content now has one shrinkable
   wrapper. Campaign names wrap on narrow screens, and copy state stays readable after
   the flash. Matching preview copies transfer to the confirmed revision and respect reset.
   The prior committed result stays identified while regenerating.
3. Eviction could race a new consumer; new pins now wait for started deletions. Reusing a
   workspace could overwrite a hardlinked cached inode; materialization now unlinks the
   owned previous entry and uses an exclusive copy fallback. Cold inspection is shared,
   while an aborted waiter leaves immediately and a failed leader does not poison siblings.
4. Stop during preflight and actor changes now prevent unsubmitted work. The batch retains
   the original actor epoch for its entire lifetime. Modifier clicks on card headings work
   like modifier clicks on the body. The created-order query has a matching partial index.
5. Convergence identified explicit ESM specifiers, a shared batch cap, the four-account /
   five-variation acceptance case, and migration recovery documentation. These are tracked
   as T022–T024; no new product scope or constitution exception was introduced.

## Behavioral evidence

- `launch-workspace.test.ts`: full migration chain, ACL and legacy list behavior, created
  chronology/cursors, bounded ID observation, current reserved catalog name vs history.
- `launch-workspace-ui.test.tsx`: 68 tests, including deferred real generation hook:
  results are selected and campaign names copyable before the mutation resolves. A
  regeneration preview copy is correlated to the new request, never the previous generation.
- `launch-batch-admission.test.tsx`: 8 tests: StrictMode, two slots, completion, invalid
  sibling, stop during preflight, permission/actor loss, off-page observation, and four
  separate account settings carrying five variations of the same source.
- `launch-bulk-selection.test.tsx`: 5 tests for range, input/modal guards, actual keyboard
  select/copy/paste/delete, uncertain paste replay with the same key and permission loss.
- `launch-copy-history.test.tsx`: 11 tests, including preview-to-revision handoff, changed
  values, failed clipboard writes, actor changes and reset.
- `restitch-multi-variation-reuse.test.ts`: 11 tests, including twenty consumers / one body,
  incompatible recipe misses, eviction, independent cancellation and hardlink retry safety.
- `restitch-shared-inspection.test.ts`: 3 tests for shared cold inspection, independent
  source paths, waiter cancellation and healthy retry after producer failure.
- `launch-analytics.test.ts`: 28 tests; typed signals through persisted event rows to actual
  `getInspect` SQL, accepted/refused/cancelled/unknown outcomes and delayed delivery. Batch
  admission never reports final delivery; child flow IDs lead to authoritative evidence.
  Emitted properties also pass the actual database privacy guard. Successful and denied
  early clipboard writes are covered in `launch-progressive-result.test.tsx` (2 tests).

## Browser acceptance

Actual production components rendered in an isolated synthetic fixture on loopback 5183,
headless local Chrome, Ukrainian UI: desktop 1280×900 in both themes, mobile 390×844.
No browser runtime errors; no horizontal mobile overflow. Copy affordance / success and
full narrow campaign names inspected in [dark list](dark-list.png), [light list](light-list.png) and [mobile results](dark-mobile-result.png). Keyboard Space toggles card selection. Reduced motion resolves to the 1ms token, and the copied state remains visible after the transient flash.
The fixture makes no provider writes and is removed from the application after acceptance.

## Final gates

Final `SOTY_VERIFY_SERIAL=1 nice -n 15 npm run verify` passed all **15/15 gates**
in 1,534 seconds. All **8/8 shards** completed: **10,991 passed**, **95 skipped**,
**0 failed** out of 11,086 tests. Skips retain the repository's explicit platform,
media-fixture and disposable-database prerequisites; they are not counted as passes.
The separate canonical real PostgreSQL run passed 1,463 SQL assertions and 84
integration/Auth tests. `npm run build` passed for shared, web and agent. Coverage
was not measured by this fast form. Exact counts, skip reasons and gate results are
archived in [verification-summary.json](verification-summary.json).

The first static run found a
`noImplicitAny:false` inference error in the shared campaign parser when imported by the
new benchmark; adding an explicit `LaunchPreview['campaigns']` annotation fixed it.
The first aggregate suite passed 8,128 tests before an existing settings test hit jsdom's
missing `Element.scrollTo`. A shared no-op browser seam fixes that test environment
prerequisite; the owner-settings regression and all 110 final-delta tests now pass.
`npm run build` completed for shared, web and agent. The web build retains its
large-chunk warning; no bundle-size waiver or limit change was introduced.
The isolated real PostgreSQL run found two pre-existing pgTAP privilege checks naming
obsolete RPC signatures. Updating those references to the current signatures (including
the already-defined default arguments) retained the same ACL assertions. The canonical
`npm run test:db` then passed all 73 SQL files / 1,463 assertions, 3 Auth tests and
81 native PostgreSQL integration tests. Its disposable containers were cleaned up.
A subsequent complete-build run passed 8,139 tests before the old download-budget
assertion failed. Exact base/feature builds separated existing 1.4.4 growth from the
new feature; the bounded allocations and unchanged caps are recorded in
`performance.md` and `bundle-budget-comparison.json`. The batch is now a lazy module.
No tests were excluded; behavioral, privacy and authorization assertions remain intact.
The download-budget assertions were updated explicitly with those measured allocations.

Final follow-up: cards now show local queued/preparing/uncertain and confirmed outcomes
while the list still contains the old draft, then defer to authoritative generation
state. An actual LaunchSpace test delays preflight to prove immediate visibility.
Lazy module loading is separately diagnosed through producer, DB privacy guard and
`inspect`; it never counts as launch admission or final delivery. Permission loss
while the module loads prevents dispatch, including a sign-out/sign-in of the same
actor before the import settles (original actor epoch fence). All 101 final follow-up tests passed,
followed by all four built-asset budget checks.

## Scope of evidence

This is implementation acceptance, not release qualification. No real Google account,
production catalog, hosted native delivery, packaged beta entitlement or physical Windows /
Intel runtime was exercised. Existing provider/native recovery contracts are retained and
covered by the repository suite. Packaged beta and the normal cross-platform release gates
remain required when this branch is selected for a future release. Unsubmitted session-local
queue items remain saved drafts after page close; browser loss does not mean accepted work
was canceled. Missing diagnostics stay unknown.


## Final scope assessment

All 30 tasks are evidenced and complete. The implementation was rechecked against
12 functional requirements, 6 success criteria, 4 user-story acceptance groups,
6 architectural constraints and the 6 constitution principles. No remaining
buildable gap was identified within the specified scope. The documented runtime /
release limitations above remain explicit and are not relabeled as completed tests.
