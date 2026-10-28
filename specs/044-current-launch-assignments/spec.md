# Current Launch assignments and RK availability

Owner-approved scope (2026-10-26): make linked Launch rows behave like retained manual entries, keep their accent colour versus manual-entry text, and align their left text edges. A pencil opens the saved Launch; the bin detaches only the current assignment, with Undo. Never delete the Launch, generated names/SUBs, files, catalogs, finance, immutable revisions or original source identity to detach it.

One Launch has at most one current assignment, one RK may hold many Launch assignments. Explicit server-accepted assignment reserves availability; selecting/highlighting, copying and background autosave do not. Released links cannot reappear from preserved config. A new generation must match its current assigned RK to its configured source; accepted work and replay retain their original snapshot. Reassigning does not retarget old output.

Availability is one server projection shared by rows, SOC counters, filters, task tags and the Launch picker: manual holds or current assignments mean busy; zero holds with unresolved legacy evidence means unknown; proven zero current and legacy holds means free. Financial dates, history, generation terminal/work status and truncated display lists cannot release a hold. Legacy source links are unconfirmed until an editor explicitly confirms current use or history-only. No age-based automatic release.

Individual release/Undo and reassignment use actor-scoped durable receipts, independent request keys and CAS. Unknown replies keep the same key and require readback; concurrent edits cannot be overwritten. Bulk release atomically clears current assignments and manual holds, refusing unresolved legacy evidence. Archive blocks new assignments; it never cancels accepted work. Restoring an entity never revives released assignments. Stable RK identity survives SOC moves.

## Diagnostics and privacy

Typed `assign_account` / `release_account` intent, acceptance/failure and committed browser visibility correlate by independent flow IDs. Database current assignment/event views expose only opaque identity, stable state/version, actor and bounded counts to the SELECT-only analytics role. `inspect` and `investigate` expose this proof independently from generation receipts. Missing schema, incomplete readback, absence of browser delivery and historical as-of uncertainty remain explicit. No names, raw account numbers, financial values, URLs, source config or provider content enter diagnostics. Assignment is organizational availability, never proof that external advertisements are running.

## Acceptance

- A saved explicitly assigned Launch occupies its RK; multiple Launches count separately and releasing one cannot free the remaining holds.
- Detach leaves source and output unchanged; Undo uses the returned version and a fresh key; stale Undo conflicts.
- Repeated/unknown requests replay once, including simultaneous editors; ordinary autosave after release never recreates the assignment.
- Current availability is unchanged across day/month/range filters and partial or missing Launch display lists; incomplete authority never becomes green Free.
- Legacy links provide current/history confirmation and remain unknown before reconciliation.
- Linked and manual rows share geometry/action positioning; accents remain distinct, with accessible labelled edit/detach controls and reader restrictions.
- Generation source mismatch/unassigned state refuses new work, while already accepted work can finish or resume.
- Verify signal production through the actual ingestion guard and read-only diagnosis; commit alone cannot claim browser delivery.

## Local validation

Run focused assignment domain, migration-chain, RPC/readback, Launch controls, account-row/Undo, generation-state and analytics regressions with one worker; run repository verification. No production changes or local acceptance-data reset are authorized by implementation. Canonical beta preparation and exact-source packaged verification remain required before release.
