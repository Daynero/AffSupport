# Refusal-memory bounds and malformed active-round readback

Base checkpoint: `6ca96a5e`. The prior complete source check passed 14 gates,
9049 tests and 66 explicit skips. It does not verify this follow-up.

Six causal regressions failed before the changes: four malformed active-round
values were accepted as an absent identity, and two persisted refusal histories
were truncated globally or by disk order. Both narrow suites then passed all
70 tests. Additional expiry and repaired-version checks also pass: reading a
remembered failure does not extend its 24-hour lifetime, and successful full
validation clears that exact version's refusal.

The API now treats an explicitly malformed active-round field as an invalid row,
preserving partial-read accounting. It cannot become a null round and falsely
confirm that an observed update is inactive. Legacy missing fields and genuine
null remain separate through the existing optional identity contract.

Refusal memory is capped independently by team, settings scope and slot. Each
scope retains at most 512 exact file versions, evicts the oldest rejection with
a deterministic tie-break and deduplicates repeated versions. Restart applies the
same policy before exposing history. An unrelated scope no longer erases a
known-bad version. Existing global network/disk/tool failures remain ineligible
for refusal memory.

Focused verification passed 168 tests across seven suites, including the real
screen decoder, manager, SQL-backed Stop diagnostics and the existing browser
and updater selection paths. Three additional transfer suites passed 84 tests.
These 252 focused passes are source evidence, not manual beta acceptance.

No migration, new grant, capability or provider write is introduced here. This
does not complete T016–T020: same-click native reselection, originating-actor and
source-pool authority, durable aggregate transfer accounting, full diagnostic
coverage and actual beta fault acceptance remain open. The external ignored
budget prototype is not shipped implementation or acceptance evidence.

Full source verification of the four frozen source/test files passed 14/14 gates, 9057 tests and 66 explicit skips; every frozen hash matched afterward. See verification-fast-refusal-round-core.json. Subsequent browser/updater history-window corrections are separate changes and are not verified by that report.

## Bounded recovery implementation in progress

The shared immutable selection kernel now bounds candidates, retry and refresh
counts, byte and active network budgets, fixed transfer ranges and retained
unsettled reservations. Repeated request identities are readback only, including
after accepted-cache reacquisition; old acquisitions cannot reject a newer one.
The native recovery coordinator preserves completed slots, replaces only proven
file-local defects and awaits rejection acknowledgement before another draw.
It refuses duplicate versions and malformed or truncated exhaustion evidence.
An expired grant can refresh the same version within the bound; a lost acceptance
reply never becomes permission to redraw. Observer failures do not stop work.

Focused source verification: 51 tests across agent-screen-recovery,
restitch-selection-budget and analytics-code-map passed. The coordinator suite
contains 23 cases. These overlap other focused counts. New closed error outcomes
include Ukrainian/English messages, transport status mappings and diagnostic code
locations. Migration 148000 is additive and remains source-only pending native
verification. This does not change the 430-migration running-beta baseline.

These primitives are not yet connected to a persistent server compare-and-swap,
protected range accounting, accepted recipe authority or the delivery/updater/
Launch execution paths. No native capability is advertised. They do not establish
same-click recovery in the product or complete T016–T020. Actual beta fault
acceptance and the full diagnostic producer-to-CLI path remain required.

The fresh compiled ESM regression later exposed an initialization cycle masked by
the bundled tests: Edge's direct restitch import read a bound from the new kernel
before the restitch module initialized it. Bounds now live in dependency-free
restitch-screen-policy.ts with unchanged values and existing exports. Three
independent-runtime imports, 24 coordinator cases, nine budget cases and 19 code
map checks passed. The owned beta was canonically restarted and its actual Edge
actor guard and subsequent provider smoke passed. This is a new implementation
fault caught in beta, not evidence for Ruslan's historical failure cause. Recovery
selection still has no advertised capability or wired product execution path.
