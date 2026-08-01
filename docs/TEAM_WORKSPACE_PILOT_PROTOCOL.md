# Team workspace 20-person pilot protocol

This protocol is the copy-ready moderator script for SC-001, SC-005, and SC-008. It does not
authorize production deployment or use of customer material. Run against the fixed isolated
pilot environment and preserve every outcome, including failures.

## Rules shared by all three cohorts

Prepare exactly 20 eligible participant records (`P01`–`P20`) before the run. Record the
Wishly web build, Agent build, platform, My Drive/Shared Drive fixture, fixture version/hash,
moderator, date, and local timezone once per cohort. Record participant IDs rather than names
or emails in the score sheet. SC-001 participants must be first-time owners; SC-005 must be a
first-use search cohort; SC-008 must be an uninterrupted first attempt. Use separate cohorts
when prior exposure would violate those conditions.

Before each participant:

1. Reset only the documented isolated fixture. Clear catalog filters and close preview or
   operation dialogs. Do not mutate a previous participant's evidence.
2. Confirm the participant is authenticated, the assigned account is active, the required
   Agent is connected where applicable, and network conditions match the recorded cohort.
3. Place the participant at the start screen named by the script. Do not point, demonstrate,
   paraphrase UI labels, suggest a filter, or explain an error.
4. Read the script verbatim. Start the timer at the stated word or action. The moderator may
   repeat the script verbatim but may not answer navigation or product questions.
5. Mark assistance, abandonment, a wrong target, a manual restart, or a threshold overrun as
   failure where the scenario says so. Product-internal idempotent retry is not moderator
   help and is allowed only where stated.

For every participant record `pass|fail`, elapsed milliseconds, assisted `yes|no`, terminal
screen/state, typed error code (if any), and one short deviation note. Never record query
text, filenames, paths, Drive IDs, email, transcript/content, provider response bodies,
tokens, grants, tickets, session URIs, or Vault IDs in analytics or shared notes. Keep any
moderator-only target mapping in the restricted fixture workbook.

## SC-001 — first team onboarding

### Preparation

- Give each participant a unique team-name card, one invitation-recipient card, and one
  accessible test Drive folder. Both My Drive and Shared Drive may be represented, but each
  participant uses only the assigned fixture.
- Start at the authenticated Team workspace before a team has been created for that
  participant.
- The backend score must be able to confirm: team exists, first invitation is persisted,
  root is confirmed, and initial sync is queued. Email delivery success is recorded
  separately and must not substitute for invitation persistence.

### Read aloud verbatim

> Create a team using the team name on your card. Invite the person on the invitation card.
> Connect and confirm the assigned Google Drive folder for that team. Stop when Wishly shows
> that the folder is connected and the initial catalog sync has been queued. Begin now.

Start the timer on “now.” Stop at the first authoritative state in which all four backend
conditions above are true. Do not stop on an OAuth redirect, folder-selection highlight,
email-provider response, or optimistic UI alone.

### Score

- Pass: all four conditions are true within `300,000 ms`, without moderator help or
  abandonment.
- Fail: any condition is false, elapsed time is over five minutes, the participant abandons,
  or the moderator provides help.
- Cohort passes SC-001 at `18/20` or better. Report the numerator and denominator exactly;
  never discard a failed participant or replace them after seeing the result.

Score-sheet columns:

`participant_id, build, drive_kind, started_at, elapsed_ms, team_created,
invite_persisted, root_confirmed, sync_queued, delivery_state, assisted, outcome,
error_code, deviation`

## SC-005 — find and open the exact material

### Preparation

- Load the fixed unfiltered catalog fixture and record its row count, version, and hash.
- Prepare exactly five target cards for each cue category: GEO, offer, language, and category
  (20 cards total). Each card identifies one exact target in the restricted moderator
  mapping; do not reveal extra filters or the target path.
- Start on the Team catalog with an empty query, no active filters, and no material open.

### Read aloud verbatim

> Using Wishly's Team catalog, find and open the exact material named on your target card.
> Stop when that exact material is open. Begin now.

Start the timer on “now.” Stop when the assigned material—not merely a matching list row—is
open. Opening any other material is a wrong-target failure, even if the participant later
corrects it.

### Score

- Pass: the exact assigned target opens within `30,000 ms` without moderator help.
- Fail: wrong target, help, abandonment, provider/product error before the target opens, or
  elapsed time over 30 seconds.
- Cohort passes SC-005 at `18/20` or better and only if assignment counts are exactly
  `GEO=5, offer=5, language=5, category=5`.

Score-sheet columns:

`participant_id, build, fixture_hash, cue_category, target_code, started_at, elapsed_ms,
exact_target_opened, wrong_target_opened, assisted, outcome, error_code, deviation`

## SC-008 — find, preview, process, and return a derivative

### Preparation

- Give each participant a task card containing a fixture target code, the requested existing
  Wishly tool, the destination folder code, and the required output-name code. The restricted
  moderator mapping resolves codes to fixtures.
- Confirm the compatible Agent is connected and the source, destination, and tool are within
  their documented limits. Start at the unfiltered Team catalog with no preview or operation
  open.
- Capture source identity/checksum, source material state, and existing derivative count
  before the attempt so integrity and exactly-one-result checks are objective.

### Read aloud verbatim

> Find the source on your task card, open its preview, process it with the requested Wishly
> tool, and return the result to the assigned team folder as a separate result. Stop when
> Wishly reports that the result is complete. Begin now.

Start the timer on “now.” This is one continuous first attempt. Internal resumable or
idempotent retry may continue automatically. A participant-triggered restart, a new operation
after failure, changing the requested source/tool/destination, or moderator help fails the
attempt.

### Score

- Pass: the exact source was found and previewed, one separate derivative reaches
  authoritative success, the original identity/content is unchanged, inherited metadata and
  provenance link are committed, and no help or manual restart occurred.
- Fail: any condition is false, the participant abandons, a false-success state is shown,
  source is overwritten, no result or multiple results exist, provenance is absent, or help/
  manual restart occurs. Record duration for every run; SC-008 has no separate time cutoff.
- Cohort passes SC-008 at `18/20` or better. Preserve all 20 first-attempt outcomes.

Score-sheet columns:

`participant_id, web_build, agent_build, drive_kind, source_code, tool,
destination_code, started_at, elapsed_ms, preview_opened, authoritative_success,
derivative_count, source_unchanged, provenance_committed, internal_retry,
manual_restart, assisted, outcome, error_code, deviation`

## Supported surfaces and hard limits

| Surface                | Pilot expectation                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Video/image            | Permission-checked byte-range preview; no full-file public URL                                                                                                         |
| TXT/SRT/VTT transcript | Sanitized text preview with full/truncated/invalid/unavailable state; transcript body never enters analytics, Realtime, audit, logs, or errors                         |
| TXT editor             | Complete valid UTF-8 `.txt` only, maximum 1 MiB, with expected-source check; `.srt`/`.vtt` and truncated/invalid text are read-only                                    |
| New version            | Separate file/material, explicit conflict choice, inherited metadata, one acyclic `version_of` predecessor; source unchanged                                           |
| Archive                | Manifest only; maximum 50,000 entries, 5 GiB expanded total, 2 GiB per entry, 500:1 ratio after 1 MiB, depth 80; reject encryption, links, traversal, and unsafe names |
| Landing                | Dedicated isolated preview; external network/navigation, forms, popups, and top navigation blocked; safe screenshot fallback                                           |
| Range request          | Maximum 32 MiB, with current permission checked again                                                                                                                  |
| Browser full download  | Maximum 100 MiB; larger files require a compatible Agent                                                                                                               |
| Agent transfer/intake  | Maximum 100 GiB; a selected tool may impose a lower limit                                                                                                              |
| Resumable upload       | 256 KiB aligned chunks; session URI remains memory-only                                                                                                                |
| Team/catalog           | 50 active members; fixed performance target of 50,000 visible materials                                                                                                |

Unsupported, corrupt, protected, unsafe, over-limit, stale, or permission-lost material must
show an explicit typed alternative or error; it must never report ready/success or leave an
extracted/provider/local residue.

## Independent Drive ACL and recovery script

Read this before a membership removal, root replacement, trash, or recovery exercise:

> Wishly permissions and Google Drive sharing are independent. Removing a member in Wishly
> immediately blocks Wishly team actions, but it does not revoke access granted directly in
> Google Drive. A Wishly role change is not proof that the Drive ACL changed.

For `NEEDS_REAUTH`, reauthorize the same intended account; catalog, metadata, provenance, and
audit history must remain. For an unavailable root, restore provider access or explicitly
confirm a replacement root, then let reconciliation run. Detaching a root must not delete
provider files. A Drive mutation followed by database failure remains unresolved until the
same idempotent operation is reconciled—do not create a replacement operation or rename the
target to “make it work.” Trash is not permanent deletion, but Wishly cannot guarantee
recovery after direct purge or expiry under current Drive/admin retention policy.

When safe continuation is impossible, end the participant attempt truthfully, capture only
the typed code and allowed score fields, preserve the fixture for investigation, and follow
[`TEAM_WORKSPACE_OPERATIONS.md`](./TEAM_WORKSPACE_OPERATIONS.md). Never expose credentials,
provider bodies, private filenames/paths, transcript text, or customer content in a support
report.
