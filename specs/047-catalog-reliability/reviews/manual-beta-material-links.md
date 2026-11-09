# Material-link beta walkthrough — pending native browser access

This is a blocked acceptance record, not a successful manual walkthrough.
Source base: e196987d with the uncommitted material-link increment. Worktree,
dependencies, test temp files and beta VM storage are now on LaCie. The new guest
source mount reads exactly the host's migration bytes; default Docker context is
unchanged. The real-auth source beta started canonically after a cold Storage
health timeout and a normal warm retry. No reset or health bypass was used.

Supabase CLI 2.117 applied exactly 20261207140000, 20261207141000 and
20261207142000 to local project r2beta045. Its complete history is now 425
migrations, matching the disposable proof's hashes. Eleven of thirteen protected
whole-table snapshots matched. Connection and credential table digests differed
while beta workers were active; those snapshots cannot identify which columns
changed. The three migrations contain no updates to those two tables, but no
claim of identical credential rows or attribution of that difference is made.
Private baseline and after snapshots are retained locally, outside Git.

The native control tool failed to start with `Sky Computer Use native pipe startup
failed`. Inventory returned no apps or browsers and reported both the native pipe
failure and unavailable browser host. Resetting its runtime and reconnecting to
Chrome reproduced the failure. Browser control recovery was requested while
independent implementation and automated verification continue.

A new 44-byte synthetic CSV is prepared on external storage, but it has not been
uploaded. No manual Get-link, Share, permission creation or clipboard success is
claimed for this increment. Earlier download and claim-recovery walkthroughs belong
to their recorded source snapshots; they do not accept this new sharing flow.

Still to execute through the real UI:

- Manager Get-link on an existing catalog; selectable URL and actual Copy/Open.
- The same action in Explorer, with the same storage/actor context.
- Upload the synthetic CSV and retrieve its initially restricted URL.
- Share with explicit consent and an initially unchecked remember choice.
- Verify public access, readback, and that repeated Share creates no second intent.
- Verify the clipboard fallback and retained URL; identify any unavailable fault injection.
- Download an actual catalog into external artifacts and verify the saved workbook.

Beta analytics remain disabled. Controlled producer-to-ingestion-to-SELECT-only
CLI tests are separate evidence, not observed production telemetry or manual UI QA.
