# Contract: the inventory after the swap

**Feature**: 024-heroui-workspace | **Files**: `apps/web/src/components/ui/*`

The inventory's **public API does not change**: the same exported names, the same prop names, the
same `color` × `variant` × `size` vocabulary, the same marker classes. What changes is what is
underneath. This is what lets 128 importing modules stay untouched while every screen in the
product gets the new controls, and what keeps `tests/ui-consistency.test.tsx` meaningful.

Shared prop model, unchanged:

```ts
color?: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'
variant?: 'solid' | 'outline' | 'soft' | 'subtle' | 'ghost' | 'link'
size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
```

Every adapter keeps emitting `ui-<name>`, `ui-<name>--<variant>`, `ui-color-<role>` and
`is-<state>` alongside the library's own classes. Those markers carry no style after the
migration; they carry the contract.

---

## Element

| Ours              | Becomes                                 | Notes                                                                                                                                                |
| ----------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`          | HeroUI `Button`                         | six variants map onto HeroUI's variants plus two utility-composed ones (`subtle`, `link`); `loading` keeps the control's width, as the rule requires |
| `IconButton`      | HeroUI `Button` icon-only               | `label` stays required; `pressed` maps to `aria-pressed`                                                                                             |
| `Badge`           | HeroUI `Badge`                          |                                                                                                                                                      |
| `Chip`            | HeroUI `Chip` / `Tag`                   | removable chips use `Tag` inside a `TagGroup`, which is what the task-label and agent-tag rows want                                                  |
| `Card`            | HeroUI `Card` / `Surface`               | `role="surface" \| "panel" \| "section"` keeps deciding tint and padding                                                                             |
| `Separator`       | HeroUI `Separator`                      | now actually used — the audit found ad-hoc `border-top` rules instead                                                                                |
| `Alert`           | HeroUI `Alert`                          |                                                                                                                                                      |
| `Progress`        | HeroUI `ProgressBar` / `ProgressCircle` | keeps `--fill-ratio` + `scaleX()`, never animating `width`                                                                                           |
| `Skeleton`        | HeroUI `Skeleton`                       |                                                                                                                                                      |
| `Spinner`         | HeroUI `Spinner`                        | keeps `--motion-spin-reduced` under reduced motion                                                                                                   |
| `Tooltip`         | HeroUI `Tooltip`                        | one delay group for the whole product                                                                                                                |
| **`Kbd`** _(new)_ | HeroUI `Kbd`                            | the shortcut sheet and the palette need it                                                                                                           |

## Form

| Ours                      | Becomes                                                          | Notes                                                                                                         |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `FormField`               | HeroUI `Fieldset` + `Label` + `Description` + `FieldError`       | label / help / error / required in one composition instead of four hand-written rules                         |
| `Input`                   | HeroUI `Input` / `TextField`                                     | leading and trailing slots become `InputGroup`                                                                |
| `InputNumber`             | HeroUI `NumberField`                                             | gives the stepper the accounts screen hand-rolled                                                             |
| `InputTags`               | HeroUI `TagGroup` + input                                        |                                                                                                               |
| `Select`                  | HeroUI `Select`                                                  | replaces eleven raw `<select>` elements                                                                       |
| **`SelectMenu`** _(new)_  | HeroUI `ComboBox` / `Autocomplete`                               | searchable and multiple; this is what the label menu, kind filter and account picker have each re-implemented |
| `Textarea`                | HeroUI `Textarea`                                                | autosize                                                                                                      |
| `Checkbox`                | HeroUI `Checkbox`                                                | `indeterminate` becomes a prop, not a `ref` poke into the DOM                                                 |
| `RadioGroup`              | HeroUI `RadioGroup`; the `pictos` variant on `ToggleButtonGroup` | the picto group is the product's signature control and keeps its exact geometry                               |
| `SegmentedControl`        | HeroUI `ToggleButtonGroup`                                       |                                                                                                               |
| `Slider`                  | HeroUI `Slider`                                                  |                                                                                                               |
| `Switch`                  | HeroUI `Switch`                                                  |                                                                                                               |
| **`SearchField`** _(new)_ | HeroUI `SearchField`                                             | one search control; today there are five, each with its own clear button                                      |

## Data

| Ours                       | Becomes                      | Notes                                                                                                                           |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Table` + cells            | HeroUI `Table`               | the accounts grid, the member list and the 2FA table stop being CSS grids pretending to be tables; column semantics become real |
| `Accordion`                | HeroUI `DisclosureGroup`     | replaces the raw `<details>/<summary>` pairs                                                                                    |
| `Empty`                    | HeroUI `EmptyState`          |                                                                                                                                 |
| `User`                     | HeroUI `Avatar` + typography |                                                                                                                                 |
| `Tree`                     | **stays ours**               | HeroUI has no tree; the folder tree keeps its drop-target behaviour and is restyled with utilities                              |
| `Timeline`                 | **stays ours**               | no counterpart; the audit's finding that an audit line carries six facts against a timeline's three still holds                 |
| **`ScrollShadow`** _(new)_ | HeroUI `ScrollShadow`        | the explorer's panes and the task editor's columns stop cutting content off without a hint                                      |

## Navigation

| Ours                  | Becomes              | Notes                                                                                 |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| `Breadcrumb`          | HeroUI `Breadcrumbs` | the second always-rendered compact copy is deleted                                    |
| `Link`                | HeroUI `Link`        | now actually used; the workspace's header links stop being raw `<a>`                  |
| `Pagination`          | HeroUI `Pagination`  |                                                                                       |
| `Tabs`                | HeroUI `Tabs`        | one keyboard behaviour for both tab strips, link mode included                        |
| **`Toolbar`** _(new)_ | HeroUI `Toolbar`     | the selection bar and the explorer toolbar become one landmark with real roving focus |

## Overlay

| Ours                      | Becomes                           | Notes                                                                                                                                                          |
| ------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Modal`                   | HeroUI `Modal`                    | `useDialogBehaviour` retires: React Aria owns the stack, Escape depth, focus return and scroll lock                                                            |
| `Drawer`                  | HeroUI `Drawer`                   | the narrow-width folder tree and the mobile detail pane                                                                                                        |
| `Popover`                 | HeroUI `Popover`                  | placement and collision handling come from the library; the "a popover that opens a dialog must not close" rule becomes a prop                                 |
| `DropdownMenu`            | HeroUI `Menu`                     | one menu implementation. The hand-rolled roving-focus copies in `ExplorerShell`, `Breadcrumb`, `TagDot`, `MaterialRowMenu` and `AgentRow` are deleted          |
| **`ContextMenu`** _(new)_ | HeroUI `Menu` at a virtual anchor | right-click in the explorer                                                                                                                                    |
| `ConfirmDialog`           | HeroUI `AlertDialog`              | the verb-naming rule stays                                                                                                                                     |
| `Toast`                   | **stays ours**                    | the product's toast carries tones with per-tone lifetimes, a one-shot action, a progress bar and live updates from a running job. It is restyled, not replaced |

## Dates _(new group)_

| New             | Is                     | Notes                                                          |
| --------------- | ---------------------- | -------------------------------------------------------------- |
| `Calendar`      | HeroUI `Calendar`      | month grid, year picker, keyboard by day / week / month / year |
| `RangeCalendar` | HeroUI `RangeCalendar` | the board's date filter                                        |
| `DatePicker`    | HeroUI `DatePicker`    | the task's date                                                |
| `DateField`     | HeroUI `DateField`     | typed entry where a popover would be heavy                     |

`@internationalized/date`'s `CalendarDate` is the type inside the UI layer only; one adapter
converts at the edge so no API or stored shape changes.

## Patterns

| Ours                         | Becomes                              | Notes                                                               |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| `EmptyState`                 | composition over HeroUI `EmptyState` | keeps the rule: an empty state that can be fixed carries the fix    |
| `LoadingState`               | composition                          |                                                                     |
| `ErrorState`                 | composition                          |                                                                     |
| `PermissionState`            | composition                          |                                                                     |
| `SelectionBar`               | composition over `Toolbar`           | now actually used — the explorer's bespoke selection bar is deleted |
| **`CommandPalette`** _(new)_ | `Modal` + `Autocomplete` + `ListBox` | ⌘K                                                                  |
| **`ShortcutSheet`** _(new)_  | `Modal` + `Kbd`                      | every binding the product makes                                     |

## Product-specific, unchanged in identity

`DropZone`, `HoneycombField`, `PowerLever` / `PowerReadout` / `PowerThrottle`, the CRF pixel gem,
`JobRow`, `TranscriptPlayer`, `TaskProgressScale`, `LandingGalleryGrid`, `StorageChip`, `Marked`,
`CodeCell` / `Countdown`, the Soty loader family. Each keeps its behaviour and is restyled from
tokens; `JobRow`, `StorageChip` and `SelectionBar` are rebuilt on the new primitives as the
previous contract already intended.

---

## Deleted, not migrated

- `apps/web/src/components/ui.tsx` — the pre-021 shim that shadows eight names by
  file-beats-directory resolution. Its 70 importers move to the inventory. Keeping it through a
  second migration would mean three generations of `Button` in one tree.
- `useDialogBehaviour`, `focusableIn`, `FOCUSABLE_SELECTOR` — React Aria owns this now.
- Every hand-rolled roving-focus block, every bespoke menu, both hand-written calendars, the
  duplicated compact breadcrumb, and the `indeterminate` `ref` poke.

## What the tests assert

- `tests/ui-consistency.test.tsx` — **unchanged**. Same role ⇒ same marker signature, on every
  screen. It keeps working only because the adapters keep emitting markers, which is the whole
  reason that rule exists in this contract.
- `tests/design-components.test.tsx` — rewritten from the deleted shim's literal classes onto the
  inventory's markers.
- `tests/team-raw-controls.test.ts` — no raw `<button>`, `<input>`, `<select>` or `<textarea>`
  under `apps/web/src/team/`.
- `/design` renders every component above, in every variant, size and state, in both themes.
