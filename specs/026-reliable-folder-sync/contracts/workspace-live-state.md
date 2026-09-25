# Contract: Workspace live state and local progress

## Subscription and recovery

After T002 governance resolution, useTeamRealtime owns the existing permitted
team_catalog_events and team_operations subscriptions. Events invalidate data;
moves invalidate old and new parents. No additional progress publication.

Subscribe, reconnect and foreground visibility trigger authoritative reads of
the visible catalog window, tree, search and storage health. Debounce affected
reads; an event during a read sets dirty and schedules a bounded follow-up.
Event IDs are identifiers, not contiguous sequences or commit watermarks.
There is no event cursor API, replay journal or MAX(id) recovery barrier.
Generation/team/route guards discard late responses. Unmount clears timers.
Failed reads preserve data and expose stale/reconnecting status. Membership
loss clears cached team data and the local operation journal.

Refresh preserves loaded pages around a stable material anchor, sorting,
filters and surviving selections. A removed anchor uses its nearest survivor.
Refreshing page five must not reset the view to page one.

## Local progress

The existing ToastProvider accepts stageLabel, detail and
`progress: number | 'indeterminate'`. One workspace provider projects at most
three active local toasts; remaining owned groups appear in a local summary.

| Stage            | Progress                                                    |
| ---------------- | ----------------------------------------------------------- |
| preparing        | Indeterminate; discovered counts                            |
| creating_folders | Confirmed directory items / known total                     |
| transferring     | Confirmed bytes / total bytes in this attempt               |
| moving           | Confirmed terminal items / total; one move is indeterminate |
| updating_catalog | Indeterminate until authoritative postcondition             |
| done             | Exact success, partial, failure or cancellation             |

Screen readers announce stages and meaningful increments (at least five
percentage points or terminal), not every upload callback. Dismissal does not
cancel. Zero-byte files still require finalization.

Percentages stay in memory. IndexedDB stores actor/team-scoped metadata on
manifest acceptance and item state changes, never byte callbacks. There are no
server group/item tables, percentage RPCs, progress polling or telemetry.
Other members see finished catalog changes, not the initiator's progress.
Identical fixtures with progress on/off must have identical cloud I/O.

After reload, reconcile saved operation IDs through existing material reads.
Unfinalized uploads need reselection and a new attempt from byte zero;
path/size equality never authorizes resuming an old byte session. Without a
local checkpoint no group history is promised. Quota failure exposes
session-only recovery. Local leases prevent duplicate execution in two tabs.
Sign-out purges actor history; retention is seven days terminal, thirty interrupted.

## Acceptance

Two accounts: catalog visibility p95 ≤5 s, max ≤15 s; reconnect ≤15 s under
healthy connectivity. Test duplicate/out-of-order events, subscribe races,
events during reads, fifth-page anchors and membership loss. Strict catalog
reread must pass before success.
