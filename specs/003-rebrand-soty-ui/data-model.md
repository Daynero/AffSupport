# Data Model: Soty Review Copy

У першому етапі немає database entities або migrations. Нижче — immutable client-side
review model і його переходи.

## ReviewCatalog

| Field | Type | Rules |
| --- | --- | --- |
| `iteration` | `ReviewIterationId` | Один visible constant, початково `soty-ui-r01` |
| `surfaces` | `readonly ReviewSurface[]` | Unique, stable IDs; порядок є catalog order |
| `exclusions` | `readonly ScopeExclusion[]` | Кожна відома позаскоупна surface має rationale |
| `themes` | `readonly ['light','dark']` | Обидві обов'язкові для approval |
| `locales` | `readonly ['uk','en-long']` | Українська основна; long-copy fixture обов'язкова |
| `viewports` | `readonly ReviewViewport[]` | 320/390/768/1024/1440 matrix |

## ReviewSurface

| Field | Type | Rules |
| --- | --- | --- |
| `id` | `SurfaceId` | Stable kebab/slash ID; unique |
| `group` | `SurfaceGroup` | auth, shell, home, tool, team, account, components |
| `title` | `string` | Ukrainian human-readable review label |
| `routeHint` | `string` | Reference to current production route, never navigation target |
| `primaryStateId` | `StateId` | Must exist in `states` |
| `states` | `readonly ReviewState[]` | At least one; unique within surface |
| `requirements` | `readonly RequirementId[]` | Links to FR/SC evidence |

## ReviewState

| Field | Type | Rules |
| --- | --- | --- |
| `id` | `StateId` | Stable within surface |
| `kind` | `CanonicalStateKind` | default/loading/empty/success/error/active/confirmation/disabled |
| `label` | `string` | Visible in state selector |
| `model` | `ReviewModel` | Discriminated union matching surface and state |
| `coverage` | `CoverageDecision` | scenario reference or explicit N/A rationale |
| `primaryAction` | `ReviewElementId \| null` | No more than one honey action per local group |

`CoverageDecision` is either
`{ applicability: 'scenario'; scenarioId: string }` or
`{ applicability: 'not-applicable'; rationale: string }`. A canonical state may never be
silently omitted.

## ReviewModel and fixtures

`ReviewModel` is a union by surface, for example:

```text
{ surface: 'home-tools'; state: HomeState }
{ surface: 'compressor'; state: CompressorState }
{ surface: 'team-workspace'; state: TeamWorkspaceState }
...
```

Each `*State` is another union by `kind`; an active compressor fixture, for example, must
carry readonly demo jobs and progress, while an error fixture must carry an approved local
message. Optional-property bags are not permitted. Fixtures use invented files, people,
teams and IDs, are declared `as const satisfies ...`, and contain no production export.

## DemoAction and transition

Closed action union:

- `navigate`
- `select-state`
- `set-theme`
- `set-locale`
- `toggle-disclosure`
- `open-overlay`
- `close-overlay`
- `advance-demo`

All transitions run through one exhaustive reducer. Disabled actions are no-ops with a
visible local explanation. No transition may call a browser/network/storage/native API.

```text
catalog -> select surface -> primary state
screen  -> select state   -> named fixture
screen  -> demo action    -> deterministic state/overlay
invalid route/state/theme -> catalog + explanatory notice
```

## DesignTokenSet

| Field | Type | Rules |
| --- | --- | --- |
| `sourcePath` | literal path | `specs/003-rebrand-soty-ui/design-tokens.json` |
| `sourceDigest` | string | Recorded in generated header to detect drift |
| `resolvedColors` | readonly map | No unresolved/cyclic aliases |
| `cssVariables` | readonly map | Scoped names start `--soty-` |
| `proposals` | readonly proposal records | Non-color tokens and outcome roles require review status |

## VisualMotifPlacement

Fields: stable element ID, motif kind (`honeycomb | bee | honey`), role
(`decorative | functional`), surface/state, safe-area rule, responsive visibility and
motion policy. Decorative motifs must be `aria-hidden`, unfocusable and
`pointer-events:none`.

## Review reference and decision

A review reference is the stable tuple
`iteration / surfaceId / stateId / elementId`. Decisions remain outside the app and record
that tuple, reviewer, decision (`change-requested | accepted | blocking`), note and
verification iteration. The app does not implement comments or persist decisions.

## ApprovalGate

State progression:

```text
draft -> in-review -> changes-requested -> in-review -> approved
```

`approved` requires written owner acceptance of all agreed key screens, both themes,
responsive/200%-zoom states, logo direction and every blocking decision. Only `approved`
permits creation of a separate functional-integration plan; it never activates production
code automatically.

