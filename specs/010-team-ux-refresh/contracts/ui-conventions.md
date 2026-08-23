# Contract: UI Conventions (dialogs, notifications, status)

Behavioral contracts every team-mode surface must satisfy after the refresh. Enforced by the
jsdom suites listed in `plan.md` → tests.

## Dialogs (FR-029, D9)

- Exactly one dialog primitive: `components/Modal` (portal, focus trap, Escape, scroll lock,
  backdrop, single z-layer). The seven hand-rolled overlays are ported onto it; the z-index
  bands 45/80 are retired for shared layer tokens.
- One overlay at a time per surface, held as a discriminated union — stacked independent
  dialogs are unrepresentable. Nested *steps* (e.g. unsaved-changes prompt inside an editor)
  are part of the owning dialog, not a second system.
- Escape and the explicit close control always work; dialogs with unsaved edits prompt first.
- Close-only surfaces are labeled with `teamClose`; only true cancels use `teamCancel`
  (see glossary).

## Notifications (FR-013/014, D2)

- One `ToastProvider` for team mode: every mutation resolves to exactly one visible outcome —
  success toast or mapped-error toast. No raw machine codes anywhere in the DOM.
- `teamErrorMessage(code, t)` is the single code→copy mapper; unknown codes get the generic
  human fallback. Codes remain the API contract; mapping is render-side only.
- Toast actions power Undo (trash, attachment detach) and Retry (sync). Toasts are
  `aria-live="polite"`, auto-dismissing unless sticky (membership-lost is sticky).
- No control may silently no-op: unavailable actions are hidden or disabled-with-reason
  (FR-015).

## Confirmation proportionality (FR-028)

| Action | Friction |
|---|---|
| Trash a file | none — immediate + Undo toast |
| Detach a task attachment | none — immediate + Undo toast |
| Delete a saved task | confirm naming the consequence |
| Revoke an invitation | confirm naming the consequence |
| Remove a member / transfer ownership | confirm (existing dialogs kept) |
| Detach drive / replace root | confirm naming the consequence; replace-root confirmation is server-validated, not client-fabricated |
| Delete a draft space | confirm naming the consequence |
| Cancel a running batch | confirm |
| Leave a space | confirm |

## Status rendering (FR-016..018, D12)

- Every loading state is labeled (text or labeled skeleton); bare "…" is banned.
- Sync banner renders all non-ready freshness states: scanning/replaying (progress + counts),
  `failed` (retry action), `unavailable` (explanation). `ready` renders nothing. No sibling
  label may contradict the banner (the hardcoded "Catalog is up to date" prop is deleted).
- Freshness cannot freeze: poll fallback runs whenever realtime is degraded during an active
  scan.
- The realtime chip appears only in degraded states (reconnecting after a grace period,
  disabled) — quiet when healthy.
- Membership loss mid-session: sticky explanatory toast + return to lobby; never a silent
  bounce.

## Background work chip (FR-032, D8)

- Visible in the workspace header whenever the space's processing provider is `running`
  (spinner + done/total). Click opens the batch dialog (viewer). Completion emits a summary
  toast (successes/failures) even with the dialog closed; a partly-failed batch never reads
  as full success.

## Empty states (FR-020)

Three distinguishable renders per list: loading (labeled), truly empty (with the next action
where one exists — e.g. "create your first task"), and empty-for-filter (says the filter is
the reason). First load never claims "nothing matches".
