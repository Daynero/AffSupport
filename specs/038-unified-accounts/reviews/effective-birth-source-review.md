# Effective creation day — independent source review

Reviewer: `/root/hover_audit`. Read-only review of the draft TypeScript changes,
the acceptance plan and migration `20261202146000_account_effective_birth.sql`.
No UI, database command, test run or implementation edit performed.

## Findings sent immediately to the implementers

1. **Transfer must not invent earlier SOC existence.** The draft parent-birth
   trigger fires on `UPDATE OF account_id` and extends the destination SOC to
   the RK's global birth. An RK born in January transferred into a SOC created
   today would backdate that SOC to January even though the destination
   placement begins today. Restrict this extension to new/backdated creation,
   or derive an extension from the effective destination placement day.
2. **RK creation drops the selected finance timezone.** AccountSpace passes
   `value.timezone`, normally undefined, while useAccounts' RK parameter shadows
   its outer finance timezone. The API then uses the browser timezone. Carry
   the finance timezone for the normal unified flow and keep the custom-client
   test seam separate. Cover a finance timezone different from the browser,
   especially around local midnight.
3. **An existing SOC disappears when its first RK is born later.** The UI keeps
   an empty visible SOC only when its lifetime agent array is empty. A SOC born
   yesterday gains a first RK today; yesterday's RK list is correctly empty,
   but the parent then disappears because its lifetime array is nonempty.
   Preserve the SOC when its effective birth permits that day and its children
   have not yet been born; distinguish this from hiding archived sources or
   search-filtered existing children.

## Contracts inspected

- Existing NULL effective dates are left unchanged by the migration, preserving
  unknown legacy data rather than deriving an authoritative birth from audit
  creation timestamps.
- New creation wrappers validate timezone and effective day, retain physical
  audit timestamps, create the initial placement transactionally, and revoke
  direct execution of the moved private base functions.
- The API rejects a canonical creation response whose effective birth does not
  match an explicitly submitted day.
- Shared snapshot parsing and finance visibility guard explicit births before
  exposing dated values, while keeping the legacy accepted-money path distinct.
- Date diagnostics use safe day buckets instead of literal dates.

Acceptance score is withheld pending the findings above and the implementers'
current database and UI evidence. This source review does not assert migration
success, production readiness or visual correctness.

## Follow-up: reported defects corrected

Re-read the current migration and TypeScript after the fixes:

- Parent extension now fires only on insert or `starts_on` update and ignores
  an update that does not actually change the date. A transfer's `account_id`
  change therefore leaves the destination's birth intact. The transfer RPC
  additionally rejects an effective day before the destination's explicit
  birth, after successful canonical-receipt replay and before the existing
  mutation path.
- Overview now filters explicit SOC/RK births later than the selected period
  end while preserving unknown NULL births, retained metadata, versions and
  other projection fields.
- AccountSpace passes the selected finance timezone for normal RK creation.
- The parent remains visible when all lifetime children are explicitly born
  after the period end, including an empty child list. Existing archived and
  non-future hidden-child behavior is retained.

The removed draft 2FA wrapper is appropriate: the obsolete public 2FA creation
RPC was already explicitly dropped in migration
`20260929100000_team_account_two_factor.sql`, so leaving it unwrapped creates
no additional creation bypass. Backend confirmed this against the applied
schema and reports a passing isolated migration integration run of 13 seconds,
including transfer rejection, unchanged destination birth and before/on-birth
overview checks. Those are backend-run results; this reviewer did not execute
the migration or tests.

No remaining blocker was found in this bounded source/security/date review for
applying the delta to the existing local beta. **Source-quality score: 9.9/10.**
This finding is review evidence, not user permission, a production migration
approval or a claim of completed browser acceptance. Root still owns the final
test, local migration and UI evidence for the exact final source revision.
