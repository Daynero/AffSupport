# Contract: Create-Space Wizard

Covers FR-008…FR-013, SC-002, SC-007.

## Shape (FR-008)

A linear flow with one primary action per step and visible progress:

`name → folder → done`

No optional or extra fields appear on any step.

## Step 1 — Name (FR-009)

- Single required text input for the space name.
- Validation reuses the existing rule: `NFC`-normalized, whitespace-collapsed, length 1…120.
- "Continue" is disabled/blocked while the name is empty or invalid, with a plain-language
  explanation.
- On "Continue": call `teamApi.createTeam(normalizedName)`.
  - Success → carry the returned `teamId` into the folder step.
  - `NAME_CONFLICT` → stay on the name step and show the conflict message (existing i18n key).

> The team row is created here because the folder step requires an existing `teamId`
> (Decision 3). Bailing on this step before "Continue" creates nothing.

## Step 2 — Connect folder (FR-010, FR-013)

- Reuses the existing drive-connect sub-flow verbatim for the new `teamId`:
  `startDriveOAuth` → authorize redirect → `listFolders('root')` → choose folder →
  `confirmDriveRoot(confirmed:false)` → `confirmation_required` (shows folder, account, and the
  independent-ACL warning) → `confirmDriveRoot(confirmed:true)` → `connected`.
- **Completion gate**: the wizard cannot finish until the sub-flow reaches `connected` — a
  connected root is required.
- **Production gating (FR-013)**: `OAUTH_APPROVAL_REQUIRED` (or the `?drive=OAUTH_APPROVAL_REQUIRED`
  callback) is surfaced as a plain-language explanation; the wizard does not complete and the
  space is not presented as ready.
- **Non-owner**: this step is only reachable by the space creator (owner). Invited members do
  not pass through folder connection; they join existing spaces via the 001 invitation flow.

## Step 3 — Done (FR-011)

- On `connected`: `enterSpace(teamId)` and render the workspace shell showing the connected
  folder's contents. The space becomes the active, persisted selection.
- The existing `team_onboarding_started/completed` analytics events bracket the flow (reused).

## Back / cancel / abandon (FR-012, SC-007)

- The user may go back a step or cancel.
- A team created at step 1 but left before `connected` is a **setup-incomplete** space: it is
  **never presented as a ready/usable space** in the lobby, only as a resumable "Continue
  setup" card.
- No delete-team capability exists in 001; hard discard is out of scope and recorded as a
  follow-up. Resuming re-enters the folder step for that `teamId`.

## Acceptance mapping

- US2 scenarios 1–6: linear steps (1), name required (2), folder required (3), open on
  completion (4), no half-created ready space (5), Drive gating explained (6).
