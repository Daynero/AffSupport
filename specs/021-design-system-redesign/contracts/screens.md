# Contract: Screens and Their States

**Feature**: 021-design-system-redesign | **Date**: 2026-09-13

Every surface the product can show, the states it can enter, and the migration group it
belongs to. This is the list the tasks are generated from; a screen missing from here is a
screen nobody redesigned.

State keys: `I` initial · `L` loading · `E` empty · `P` populated · `Pa` partial ·
`F` failed · `Pe` permission-limited · `O` offline (agent required) · `B` busy

---

## C1 — Entry and system states

| Screen | Route / trigger | States | Notes |
|---|---|---|---|
| PublicHomePage | `/` signed out | I, P | marketing surface; CTA above the fold, honest permission copy |
| LoginPage | `/login` | I, B, F | Google first, beta account secondary; the beta button currently wraps to four lines |
| PrivacyPage / TermsPage | `/privacy`, `/terms` | L, P | long-form measure cap (70ch) |
| AuthCallbackPage | `/auth/callback` | L, F | |
| AuthHandoffPage | handoff path | L, F | |
| AuthLoadingScreen | any protected route while resolving | L | one loader, not three |
| AuthRecoveryScreen | session without profile | I, B, F | "session is live, profile did not load" + retry + sign out |
| BlockedAccountScreen | blocked | P | |
| BlockedAccountScreen (deleted) | deleted | P | different copy, same anatomy |
| ConfigErrorScreen | misconfiguration | P | names what is missing |
| AskWebsiteForSession | agent copy, no session | L | |
| ProfileOnboarding | first sign-in | I, B, F | language choice + marketing consent |

## C2 — Shell and cross-cutting

| Surface | Where | States | Notes |
|---|---|---|---|
| Top bar | every protected route | P, O | logo, support chip, environment badge, theme toggle, language switch, connection chip, user menu |
| Support chip + dialog | top bar | I, L, P, F | goal, progress, contribute |
| Connection chip | top bar | connected, connecting, offline, update-required | |
| UserMenu | top bar | P | |
| Toasts | global | info, success, warning, error, with action, sticky | |
| Modal chrome | global | open, nested, busy | backdrop, close, focus trap |
| Tooltip | global | — | delay group |
| ReleaseUpdateNotice | global | P, B | |
| LocalAppDialog | tools without agent | P (mac/windows variants) | the single `O` pattern |
| FeatureLockDialog | gated feature | P | |
| InstantTips | tools | P | |
| Empty / Skeleton / Error patterns | global | — | defined once here, used everywhere |

## C3 — Tools home and compressor

| Screen | Route | States | Notes |
|---|---|---|---|
| HomePage (tool grid) | `/` signed in | P | six tool cards + team card, "in development" state |
| Compressor | `/compressor` | I, E, P, B, F, O | drop zone, settings panel, batch toolbar, job rows, results, image embedding |
| TeamCompressorDialog | from team explorer | I, B, F | |

## C4 — Stitcher and landing optimizer

| Screen | Route | States | Notes |
|---|---|---|---|
| StitcherPage | `/stitcher` | I, E, P, B, F, O | |
| LandingOptimizerPage | `/landing-optimizer` | I, E, P, B, F, O | |
| LandingJobCard | within optimizer | P, B, F | |
| ImageCompareModal | within optimizer | P | before/after |

## C5 — Transcription

| Screen | Route | States | Notes |
|---|---|---|---|
| TranscriptionPage | `/transcription` | I, E, P, B, F, O | |
| TranscriptionSettingsPanel | within | P | mode, language, turbo |
| TranscriptionRow | within | queued, running, paused, done, failed | |
| TranscriptPlayer | within | P, B | |
| TranscriptTextModal | overlay | L, P, B, F | the 1,000-line file the constitution names as a debt |
| ExportMenu / CopyMenu | overlay | P | |
| LanguageCombobox / LanguageDoubt | within | P, E | |
| ModelGate / GemmaConsent / TranslatorNotice | within | P, B, F | |

## C6 — 2FA notebook and landing viewer

| Screen | Route | States | Notes |
|---|---|---|---|
| TwoFactorPage | `/2fa` | I, E, P, B, F | entries, add, edit, delete |
| TwoFactorRow / CodeCell / Countdown / QuickCode | within | P | expiry ring, copy feedback |
| LandingViewer | `/landing-preview` | I, E, P, L, F, O | |
| LandingViewerWelcome | within | E | |
| LandingTree / LandingGalleryGrid | within | L, E, P | |
| LandingSourceSwitcher / RefreshControl | within | P, B | |
| GallerySettingsMenu / GalleryMoreMenu | overlay | P | |

## C7 — Account and admin

| Screen | Route | States | Notes |
|---|---|---|---|
| AccountPage | `/account` | L, P, B, F | profile, language, consent, danger zone |
| AdminPage | `/admin` | L, E, P, F, Pe | metrics, user table, filters, CSV export |

## C8 — Team: entry and shell

| Screen | Route | States | Notes |
|---|---|---|---|
| SpaceLobby | `/team` | L, E, P, F | spaces list, invitations, create |
| SpaceCard | within lobby | P, preparing | |
| InvitationList | within lobby | E, P, B | |
| CreateSpaceWizard / SpaceNameStep | overlay | I, B, F | two steps |
| WorkspaceShell | `/team/:id` | L, P, F, Pe | section tabs, header, storage chip |
| SpaceSwitcher | within shell | P | |
| SpaceStatePanel | within shell | preparing, needs-storage, ready | |
| Unavailable space | `/team/:id` no access | P | |
| ConnectStorageFlow / SelectionList | overlay | I, L, P, B, F | |
| RealtimeChip / BackgroundWorkChip | within shell | idle, live, working | |

## C9 — Team: explorer

| Screen | States | Notes |
|---|---|---|
| ExplorerShell | L, E, P, F, Pe | list and grid views |
| FolderTree | L, E, P | drop targets |
| Breadcrumb | P | truncation |
| ContentList / ContentGrid | L, E, P, B | row and tile |
| Selection bar | P | count, actions, clear (N) |
| RowActions / ShareButton / MaterialRowMenu | P, Pe | |
| SortMenu / KindFilterMenu | P | |
| PreviewPane | E, L, P, F | |
| TrashView | L, E, P, B | restore, purge |
| UploadConflictDialog / FolderScopeDialog | P, B | |
| ProcessPanel | P, B, F | |

## C10 — Team: catalogue and search

| Screen | States | Notes |
|---|---|---|
| TeamCatalog | L, E, P, F | search results |
| CatalogSearchBar | I, P, B | scope switch |
| CatalogFilters | E, P | seven filters, facet-driven |
| MaterialResults | L, E, P | |
| MaterialMetadataEditor | P, B, F | geo, language, offer, tags |
| ProvenancePanel | L, E, P | |
| FolderPicker | L, E, P, B | |
| TeamTextEditor | L, P, B, F | |

## C11 — Team: tasks

| Screen | States | Notes |
|---|---|---|
| TaskSpace (board) | L, E, P, F, Pe | status columns |
| TaskCard | P | progress, tags, agents, attachments |
| TaskEditor | I, P, B, F | the densest dialog in the product |
| TaskStatusControl / SortControl / DateField | P | |
| TaskDateFilter / AssigneeFilter / AccountFilter / LabelFilter | E, P | |
| TaskAgentTags | E, P, B | |
| TaskAccountPicker | L, E, P, B | two levels, free/all |
| TaskAttachmentPicker / Tile | L, E, P, B | search + folders |
| TaskProgressScale | P, B | |

## C12 — Team: accounts

| Screen | States | Notes |
|---|---|---|
| AccountSpace | L, E, P, F, Pe | table, filters, summary |
| AccountGroup / AgentRow | P, B | fold, money, runs |
| AgentMoney | P, B | balance, top-up, steppers |
| AgentLabels | E, P, B | |
| MarkerFilter | P | colour markers |
| Copy / clear actions | P, B | with undo |

## C13 — Team: settings and members

| Screen | States | Notes |
|---|---|---|
| SettingsDialog | P | five tabs, sticky bar |
| TeamPreferencesSection | L, P, B | |
| SharePreferenceSettings | P, B, F | |
| DriveConnectionPanel | connected, needs-reauth, root-missing, unavailable, B, F | |
| LeaveSpacePanel | P, Pe, B | owner variant |
| MemberList | L, E, P, B, Pe | roles, permissions |
| MemberPermissionsDialog / OwnershipTransferDialog | P, B, F | |
| InvitationPanel | E, P, B, F | |
| TaskLabelsSection (task and agent) | E, P, B | |
| RestitchDefaultsSection | I, L, P, B, F, O | |
| TeamAuditPanel | L, E, P, F | |

## C14 — Team: media and processing

| Screen | States | Notes |
|---|---|---|
| MaterialPreview | L, P, F, O | media, transcript, archive, landing |
| PreviewUnavailable | P | reason + allowed actions |
| LandingPreviewFrame | L, P, F | |
| LandingFullView | L, P, F | device presets, zoom |
| MaterialProcessFlow / ProcessMaterialDialog | I, B, F, O | tool choice, destination |
| OperationStatus | B, P, F | stages and progress |
| BulkUploadDialog | I, B, Pa, F | per-file progress |
| ProcessLibraryDialog | I, B, F | |
| LibraryShareActions / VideoTextActions / CopyDriveLinkButton | P, B, F | |

---

## Verification matrix

Every row above is verified at: **1920 / 1440 / 1024 / 768 / 390** CSS px × **dark / light** ×
**normal / reduced motion**, with Ukrainian strings (the longer of the two languages), by
keyboard alone, and against the state checklist from `data-model.md`.

Totals: 15 routes · 12 entry/system surfaces · 9 shell surfaces · ~70 screen-level components
and overlays · 14 migration groups.
