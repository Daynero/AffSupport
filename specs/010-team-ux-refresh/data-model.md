# Phase 1 Data Model — Team Mode UX Refresh

No new tables. The refresh adds three SQL functions, one listing read, several client-side
state machines, and new audit action codes. Existing entities are listed only where this
feature touches their states or surfaces. Decision references (D1…D15) are in `research.md`.

## 1. Route (client-side address model) — new (D1)

```
TeamRoute =
  | { kind: 'resolver' }                            // /team            (+ ?drive=… preserved)
  | { kind: 'space'; spaceId: string;
      section: 'files' | 'tasks' | 'creatives' | 'landings' | 'settings' | 'trash';
      query: { q?: string; task?: string; folder?: string } }
```

- Canonical default section is `files` and is written as bare `/team/<spaceId>` (no suffix);
  all other sections append their slug.
- Parsing is total: any unparseable tail → `{ kind: 'resolver' }` (never a crash page).
- Validation: `spaceId` is treated as opaque; membership is proven by the RLS-backed data
  fetch, not by the URL. A denied/absent space renders the neutral no-access state (001
  FR-016 — same output for "not found" and "not yours").
- Relationships: `query.task` opens the task editor over the `tasks` section;
  `query.folder` restores the Files browser position; `q`+filters restore search.

## 2. Space (team) — existing entity, states surfaced and one new transition

States shown to users (derived, per `spaceReadiness` + connection state):

```
draft (setup_incomplete: owner, never connected)   → deletable (new)
preparing (invited member, not yet connected)      → read-only card
ready (connected)                                  → enterable
needs_reauth | detached | unavailable              → explanatory state (FR-024)
```

Transitions added by this feature:

- `draft --delete_draft_team--> gone` — owner only; **guard: no drive connection row has
  ever existed for the team** (a detached space is NOT a draft); cascades memberships +
  invitations; audit `team.draft_deleted`.
- `member --leave_team--> non-member` — self, non-owner only; owner receives
  `OWNER_TRANSFER_REQUIRED`; audit `membership.left`; response carries the standing
  `EXTERNAL_DRIVE_ACCESS_REMAINS` warning (Drive ACLs are an independent circuit).

Invariants preserved: exactly one owner; owner cannot leave or be removed; permission-shaped
UI (a member who cannot manage sees no management affordances).

## 3. Invitation — existing entity, new surfaces only (D7)

No schema change. Surfaced states: `pending` (actionable in lobby), with existing
delivery-state chips. Client rules:

- Lobby renders `listMyInvitations()` above space cards; accept → enter space (or show
  `preparing` card); decline → row disappears.
- Home entry card badge = count of pending invitations (non-blocking fetch; absence of the
  datum renders no badge, never an error).
- Resolver rule (D14): pending invitations suppress single-space direct entry.

## 4. Material (file) — existing entity, lifecycle finally round-trips (D5)

Server truth already models `lifecycle: 'active' | 'trashed' | 'missing'`. This feature adds
the read and the UI transitions:

```
active --trash (drive-ops/trash)--> trashed        [no confirm; success toast with Undo]
trashed --restore (drive-ops/restore)--> active    [from Undo, or from the trash view]
trashed --(Drive retention / external purge)--> missing/gone   [rendered honestly on failure]
```

- New read: `list_team_trashed_materials(p_team, p_limit, p_before)` → newest-first page of
  trashed rows (id, name, kind, trashedAt, path hint). Requires `view` permission.
- Undo validation: restore failures (already restored elsewhere, purged, permission lost)
  surface the operation's machine code through the shared error mapper — no silent no-op.
- Transcript sidecars keep moving with their source as one logical group (005 rule,
  unchanged — trash/restore of a video carries its sidecar; the UI copy in the trash view
  reflects the group).

## 5. Task — existing entity, new client-side draft phase + delete (D6, D13)

```
(none) --"Create task"--> draft (client-only: title, note, staged attachment ids)
draft --Save--> saved (create_team_task [+ attach_team_task_materials])
draft --Cancel/Escape--> (none)            [unsaved-changes prompt only if edited]
saved --edit/status/progress--> saved      (existing update_team_task)
saved --delete_team_task--> gone           [confirm; edit permission; audit task.deleted]
attachment --detach--> detached            [no modal; Undo toast re-attaches]
```

Validation unchanged (title 1..160 NFC-normalized, note ≤2000). The draft is not persisted
anywhere — a refresh discards it by design (it exists only between "Create task" and Save).

## 6. Background processing batch — existing server queue, new client state machine (D8)

Provider-owned state (space-scoped, survives dialog close; dies with the workspace shell):

```
idle --start--> running { activeKind, done, failed, total? }
running --NO_WORK--> complete { summary }          [summary toast even if dialog closed]
running --error--> failed { code }                 [retryable via retry_failed_library_jobs]
running --cancel (explicit, confirmed)--> canceled
running --provider unmount (leave /team, close tab)--> lease released; queue intact server-side
```

Server lease protocol untouched: claim → context → heartbeat → complete/fail; expired leases
are reclaimable. Invariant (FR-032/005): a partly-failed batch must never summarize as full
success.

## 7. Notification (toast) — new client-side model (D2)

```
Toast = { id, tone: 'success' | 'error' | 'info', text: TranslationKey-resolved string,
          action?: { label, run }, sticky?: boolean }
```

- Single provider per app shell; `aria-live="polite"`; auto-dismiss (non-sticky) with a
  duration long enough to reach the Undo action; actions are one-shot.
- Every team-mode mutation resolves to exactly one toast (success or mapped error) — the
  invariant behind SC-004.

## 8. Overlay (dialog) state — per-surface discriminated union (D9)

`TeamCatalog` (and any surface juggling >1 overlay) holds
`overlay: { kind: 'edit' | 'preview' | 'text' | 'process' | 'operation' | 'provenance' | 'version'; … } | null` —
one overlay at a time by construction; every overlay renders through `components/Modal`.

## 9. Sync & connection status — existing data, rendered states (D12)

```
catalogFreshness.state: not_started | scanning | replaying | ready | failed | unavailable
   → banner renders scanning/replaying (progress), failed (retry), unavailable (explanation);
     ready renders nothing (quiet success).
realtimeState: connecting | connected | reconnecting | disabled
   → header chip renders only degraded states (reconnecting after grace, disabled).
Poll fallback: freshness refetch on interval while a scan is active and realtime ≠ connected.
```

## 10. Audit event — existing entity, three new action codes

`membership.left`, `team.draft_deleted`, `task.deleted` — same envelope, actor = the acting
user, result recorded as today. No reader changes (the audit panel renders action strings
generically).

## 11. i18n keys — contract-governed strings (D11)

- Renames ride the compile-checked `TranslationKey` union; the canonical vocabulary and the
  forbidden list live in `contracts/glossary.md` and are enforced by
  `tests/team-i18n-glossary.test.ts`.
- Collapsed keys: the three Cancel duplicates → `teamCancel` (true cancels) + `teamClose`
  (close-only surfaces). Placeholder `teamWorkspaceGateTitle` is replaced with real copy in
  both locales.
