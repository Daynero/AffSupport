# Quickstart & Validation: Спрощений покроковий інтерфейс командного простору

How to validate the redesigned team-space flow end-to-end. This feature is frontend-only, so
validation is primarily DOM tests plus a manual walkthrough in the web app; no database or
Edge test suite is involved.

## Prerequisites

- Node per repo standard (validation on Node 22); dependencies installed.
- Shared package built (needed only if an optional analytics event was added to
  `@video-compressor/shared`): `npm run build -w @video-compressor/shared`.
- For the manual walkthrough: a running web app with an authenticated user. Drive folder
  connection requires `DRIVE_OAUTH_MODE=testing` outside production (per 001); in production it
  stays gated with `OAUTH_APPROVAL_REQUIRED`.

## Automated validation (authoritative)

Run the feature's DOM tests and the standard gates:

```bash
npm run format:check
npm run lint
npm test                      # builds shared, runs vitest
npm run build -w @video-compressor/web
```

Feature test files (see plan.md → Project Structure):

- `tests/team-space-lobby.test.tsx`
- `tests/team-space-cache.test.tsx`
- `tests/create-space-wizard.test.tsx`
- `tests/workspace-shell.test.tsx`
- `tests/space-settings.test.tsx`
- `tests/team-workspace.test.tsx` (updated to the new shell composition)

These drive the surfaces through `TeamContextOverride` and injected `client` stubs, the same
pattern as the existing `tests/team-workspace.test.tsx`.

## Scenario walkthrough (maps to spec Success Criteria)

### 1. Entry & lobby — US1 / SC-001, SC-003

1. From the home screen, activate the Team Space card → lands on `/team`.
2. With no saved selection and ≥1 team → the **lobby** shows team cards + "Create a new space",
   and **no** management panels or filters. _(FR-002)_
3. Select a `ready` space → its **workspace shell** opens. _(FR-003)_
4. Reload / reopen `/team` → the shell opens **directly**, no lobby. _(FR-004, SC-003 — one
   action)_
5. Click **Change space** → back to the lobby; pick another → it opens. _(FR-005)_

**Expected**: exactly one of lobby/shell renders; the saved selection skips the lobby; Change
space always returns to it.

### 2. Create wizard — US2 / SC-002, SC-007

1. From the lobby (or the empty state with no teams), start **Create a new space**.
2. Leave the name empty → **cannot continue**; enter a valid name → continue. _(FR-009)_
3. On the folder step, do not connect → **cannot finish**. _(FR-010)_
4. Connect one folder via the existing drive-connect flow → finish → land in the new space's
   shell showing the folder. _(FR-011)_
5. Restart, enter a name, advance to folder, then cancel → return to the lobby: the space
   appears only as **"Continue setup"**, never as a ready space. Resuming re-enters the folder
   step. _(FR-012, SC-007)_
6. With production Drive gating active → the folder step explains `OAUTH_APPROVAL_REQUIRED` in
   plain language and does not finish. _(FR-013)_

**Expected**: both required steps gate completion; abandoned setup is resumable, never a ready
space.

### 3. Decluttered shell & disclosure — US3 / SC-004, SC-005, SC-006

1. Open a freshly created **empty** space → the shell shows folder contents centrally, with
   **zero filters** and **zero side management panels**. _(FR-014, FR-015, SC-004)_
2. Open **Space settings** → find Members, Invitations, Drive connection (owner), Audit
   (owner/admin) — each reachable in ≤ 2 actions and permission-gated. _(FR-016, FR-019,
   FR-020, SC-005)_
3. Add materials, then invoke Search → only facets that exist for the current content appear;
   no empty/irrelevant filters. _(FR-017)_
4. As a viewer-role user → controls you cannot use do not appear on the shell or in settings.
   _(FR-020)_
5. Narrow the viewport / zoom → lobby, wizard, and shell stay readable with no horizontal
   scroll of primary content; tab through with visible focus. _(FR-021)_

**Expected**: minimal default surface; all 001 capabilities reachable behind one settings
entry; filters appear only with content.

## What "done" looks like

- All feature DOM tests pass; `format:check`, `lint`, `test`, and the web build are green.
- Manual walkthrough scenarios 1–3 behave as described.
- No new backend surface introduced (grep confirms no new migration / Edge function / RPC);
  `packages/shared` diff is empty or limited to a single analytics event name.
- The tree stays `any`-free and Prettier/ESLint clean.
