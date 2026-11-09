# Controlled screen ranges — partial working verification

Controller-only migration165000 adds a private immutable binding between a leaf
range grant and its enrolled native control. It is not applied to beta. Current
beta schema is447; its retained data has not been migrated to448. No HTTP route or installed capability is enabled.

The issue wrapper derives root/team/actor/native boot/executor epoch from the
private control. Reservation, leaf grant and control binding commit together. An
existing unbound grant cannot be adopted. Generic internal range grants cannot
use the controlled transport.

Consume checks the original control's current Auth session and owner, using the
leaf ticket's private immutable binding. A separate check validates that the
original server invocation still owns an unsettled reservation immediately before
protected upstream I/O. Completed consumption remains bookkeeping; it is not
permission for another provider request. The original reader must still own its
single payload dispatch and meter actual upstream waits/prefixes.

Original readback remains possible after logout/cancellation. Known-zero abandon
requires an unconsumed permit; consumed uncertainty stays held. Refresh uses the
same actor/owner scope and original bounded budget. All seven wrappers are
service-only and direct binding-table access is denied even to service_role.

The new internal consumer keeps its fresh server invocation/hash in a private
closure, freezes exposed scope/reservation data, and compares the full original
leaf/native-boot/owner/reservation fingerprint on authority checks. It never falls
back to legacy consume. The strict receipt parser is shared with the existing
internal dispatcher. The controlled upstream dispatcher now rechecks current
authority before credential resolution and every metered OAuth, metadata and media
fetch, then checks cancellation again before provider dispatch. It keeps the
original reservation and uses the existing measured settlement path. No public
host, native factory or installed capability is wired.

Focused verification:117 tests pass in four files (81 SQL-backed cases including
nine new controlled cases,17 legacy consumer,9 controlled consumer and10 verified
Auth session extractor cases). Six upstream boundary regressions failed before the
controlled dispatcher existed and pass afterwards; their combined run with the
protected reader, consumer and Auth cases passes50 tests in four files. These
runs overlap and must not be added as unique totals. Targeted lint and full test
type checking pass. Twelve native pgTAP assertions and two real PostgreSQL
logout-lock races are written but not executed yet. Native replay, actual beta
application, full-source and manual verification remain pending.

The previous frozen447 source V7 passes all13 static gates, but its full unit
suite exceeds the canonical45-minute limit after seven complete shards. Those
seven shards contain no failed tests; this is not a complete verification pass.
No gate timeout was changed. The79 frozen input hashes still match.

Required diagnostic stages: original issue requested/unknown/acknowledged, bound
consume requested/unknown/acknowledged, current-authority refusal, upstream start,
measured settlement, abandonment/refresh and user delivery. Correlate original
root/control grant/claim/epoch, slot/version/acquisition, request/leaf grant and
attempt IDs. Keep current bookkeeping separate from immutable historical events.
Never emit ticket/hash, Auth session IDs, provider IDs/payloads, content or paths.
No producer-to-CLI coverage or user-visible fallback is claimed by this draft.

Source-purpose lifetime, native secret persistence/controller, verified Auth
session extractor hosting, old-boot/unknown-claim recovery, updater/Launch aliases and
retirement remain open before capability exposure. Manual acceptance is pending.
