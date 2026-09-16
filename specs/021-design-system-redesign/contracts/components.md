# Contract: The Component Inventory

**Feature**: 021-design-system-redesign | **Files**: `apps/web/src/components/ui/*`

45 components. 33 map onto a Nuxt UI counterpart and take its name and prop model; 12 are
product-specific and are recorded with the same rigour. Every one of them is rendered on
`/design` in every variant, size and state.

Shared prop model, on everything that takes it:

```ts
color?: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'
variant?: 'solid' | 'outline' | 'soft' | 'subtle' | 'ghost' | 'link'
size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
```

---

## Element

| Component       | Variants                     | Sizes    | States                                        | Replaces today                                                                                                                                         |
| --------------- | ---------------------------- | -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Button**      | all six                      | all five | rest, hover, active, focus, disabled, loading | `.button-primary/-secondary/-ghost/-danger`, `.team-agent-run-add`, `.team-accounts-fold-all`, `.team-empty-action`, `.text-button`, `SelectionAction` |
| **IconButton**  | ghost, soft, outline         | xs–lg    | + `pressed`                                   | `.team-agent-action`, `.icon-button`, row action buttons                                                                                               |
| **Badge**       | solid, soft, subtle, outline | xs–md    | —                                             | `StatusBadge`, `.team-connection-badge`, `.team-delivery-state`, `.estimate-tag`                                                                       |
| **Chip**        | soft, outline                | xs, sm   | rest, removable, selected                     | `TaskLabelChip`, `.team-task-agent-chip`, `.team-agent-labels`                                                                                         |
| **Avatar**      | —                            | xs–lg    | image, initials, fallback                     | `UserAvatar`                                                                                                                                           |
| **Alert**       | soft, subtle, outline        | sm, md   | —                                             | `.team-inline-error`, `.team-inline-note`, `.team-test-mode-note`, `BetaStorageNotice`                                                                 |
| **Card**        | surface, panel, section      | —        | rest, interactive, selected                   | `.team-panel`, `.settings-panel`, `.settings-section`, `Card`, `.tool-card`                                                                            |
| **Separator**   | —                            | —        | horizontal, vertical, with label              | ad-hoc `border-top` rules                                                                                                                              |
| **Progress**    | linear, circular             | xs–md    | determinate, indeterminate                    | `ProgressBar`, `.batch-progress`, `Spinner`                                                                                                            |
| **Skeleton**    | text, block, row, tile       | —        | —                                             | `LabeledSkeleton`                                                                                                                                      |
| **Kbd**         | —                            | xs, sm   | —                                             | inline `<kbd>` styling                                                                                                                                 |
| **Collapsible** | —                            | —        | open, closed                                  | `Collapse`, `.settings-collapse`, `.team-restitch-fold`                                                                                                |
| **FieldGroup**  | —                            | —        | —                                             | `.team-inline-actions`, `.settings-section-actions`                                                                                                    |

## Form

| Component            | Variants            | Sizes  | States                                                | Replaces today                                                      |
| -------------------- | ------------------- | ------ | ----------------------------------------------------- | ------------------------------------------------------------------- |
| **FormField**        | —                   | —      | label, help, error, required                          | `.field`, `.field-group`, `.field-label`, `.team-dialog-form label` |
| **Input**            | outline, subtle     | xs–lg  | rest, focus, disabled, invalid, with leading/trailing | `.field input`, `.time-input`, `.team-invite-form input`            |
| **InputNumber**      | outline             | xs–md  | + stepper                                             | `input[type=number]`, `AgentMoney` steppers                         |
| **Textarea**         | outline             | sm, md | + autosize                                            | task description, transcript edit                                   |
| **Select**           | outline, subtle     | xs–lg  | rest, open, disabled, invalid                         | `.field select`, catalogue filters                                  |
| **SelectMenu**       | outline             | sm, md | + search, + multiple                                  | `LanguageCombobox`, `KindFilterMenu`, `TaskLabelMenu`               |
| **Checkbox**         | —                   | xs–md  | rest, checked, indeterminate, disabled                | `Checkbox`, explorer row checkboxes                                 |
| **RadioGroup**       | list, cards, pictos | sm, md | —                                                     | `.fit-mode-pictos`, onboarding language choice                      |
| **Switch**           | —                   | sm, md | on, off, disabled                                     | `.feature-switch`                                                   |
| **Slider**           | —                   | sm, md | + gradient track                                      | `.rate-slider`, `.crf-gradient`                                     |
| **SegmentedControl** | soft                | xs–md  | —                                                     | `SegmentedControl`, `.task-status-filter`, scope switch             |
| **InputTags**        | —                   | sm     | —                                                     | task tags input, metadata tags                                      |
| **FileUpload**       | dropzone, button    | —      | idle, dragging, rejecting, busy                       | `DropZone` (product-specific shell, this anatomy)                   |

## Data

| Component     | Notes                                                                        | Replaces today                                                                              |
| ------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Table**     | header, row, cell, dense (`xs`/`sm`), sticky header, selectable, row actions | accounts table, member list, audit list, invitation list                                    |
| **Empty**     | icon + title + sentence + action                                             | `.team-empty-state`, `.team-task-picker-empty`, `.team-space-lobby-empty`, `.catalog-empty` |
| **Accordion** | single/multiple                                                              | `details` usages, `.team-role-guide`                                                        |
| **Tree**      | node, expand, select, drop-target                                            | `FolderTree`, `LandingTree`                                                                 |
| **Timeline**  | entry, marker, meta                                                          | `TeamAuditPanel` list                                                                       |
| **User**      | avatar + name + meta                                                         | member rows, assignee display                                                               |

## Navigation

| Component          | Notes                       | Replaces today                                                |
| ------------------ | --------------------------- | ------------------------------------------------------------- |
| **Tabs**           | underline and pill variants | `.team-space-tabs`, `.team-settings-tabs`, workspace sections |
| **Breadcrumb**     | truncating, with root       | explorer `Breadcrumb`, picker paths                           |
| **Link**           | inline and standalone       | `a` rules scattered across screens                            |
| **Pagination**     | —                           | catalogue paging                                              |
| **CommandPalette** | search + grouped results    | catalogue search bar (future-facing)                          |

## Overlay

| Component        | Sizes                | States                                             | Replaces today                                                                                             |
| ---------------- | -------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Modal**        | sm, md, lg, xl, full | open, nested, busy                                 | `Modal`                                                                                                    |
| **Drawer**       | sm, md               | —                                                  | mobile folder tree                                                                                         |
| **Popover**      | —                    | —                                                  | `.team-task-label-menu`, tag popovers, date pickers                                                        |
| **DropdownMenu** | —                    | item, danger item, separator, header               | `SortMenu`, `KindFilterMenu`, `RowActions`, `MaterialRowMenu`, `ExportMenu`, `GalleryMoreMenu`, `UserMenu` |
| **ContextMenu**  | —                    | —                                                  | explorer right-click                                                                                       |
| **Toast**        | —                    | info, success, warning, error, with action, sticky | `toast.tsx`                                                                                                |
| **Tooltip**      | —                    | with delay group                                   | `Tooltip`, `data-tip` attribute pattern                                                                    |

## Product-specific (no Nuxt UI counterpart)

| Component                                     | Why it stays its own                                           | What changes                         |
| --------------------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| **DropZone**                                  | the compressor's full-bleed intake is the product's front door | tokens, states, reduced motion       |
| **HoneycombField**                            | brand background                                               | tokens only                          |
| **PowerLever / PowerReadout / PowerThrottle** | a physical metaphor with no generic equivalent                 | tokens, focus, reduced motion        |
| **CRF pixel gem**                             | a slider whose handle degrades as quality drops                | tokens, reduced motion               |
| **JobRow**                                    | queue row with progress, actions and inline errors             | rebuilt on Table + Progress + Badge  |
| **TranscriptPlayer**                          | waveform, segments, sync                                       | tokens, focus, keyboard              |
| **TaskProgressScale**                         | drag scale with snapping                                       | tokens, reduced motion, keyboard     |
| **LandingGalleryGrid**                        | device-framed previews                                         | tokens, skeleton, empty              |
| **StorageChip**                               | live state + detail popover                                    | rebuilt on Badge + Popover           |
| **Marked**                                    | search-term highlighting                                       | tokens                               |
| **CodeCell / Countdown**                      | TOTP digits and expiry ring                                    | tokens, reduced motion               |
| **SotyLoader family**                         | brand loaders                                                  | consolidated to two: inline and page |

### Anatomy, as built (T027)

Recorded after the migration, because what a component is made of is only
settled once it is. Each one names a token for every value it draws; none of
them spells a colour, a duration, a radius or a type step of its own.

| Component                                     | Anatomy                                                                                                                                                                                    | Motion                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **DropZone**                                  | outer target (`--radius-xl`, dashed `--color-border`) → icon plate → title → hint → hidden file input. The whole target is the label.                                                      | `is-dragging` raises the fill only; no size change, so the page under it does not move                     |
| **HoneycombField**                            | absolutely-positioned SVG field, `--purple-*` at low alpha, `aria-hidden`                                                                                                                  | ambient loop, exempt from the 300ms ceiling; removed under reduced motion                                  |
| **PowerLever / PowerReadout / PowerThrottle** | track → fill (`scaleX(var(--fill-ratio))`) → thumb → readout. The colour interpolates through a registered custom property (`--power-level-color`), not through a class swap.              | `--motion-base`, `--ease-out-curve`; the drag itself is untransitioned                                     |
| **CRF pixel gem**                             | a `<canvas>` inside a picto button: the lucide Gem is rasterised through a shrinking sample, so the crystal visibly falls apart as CRF climbs. Carries `is-zoomed` while its slider moves. | scale only, and only while dragging                                                                        |
| **JobRow**                                    | checkbox → title block → status badge → progress panel (`ProgressBar`, sizes, timer) → media panels → action row. Status colour comes from the badge's role, not from the row.             | progress scales; the row's own wash is a background change                                                 |
| **TranscriptPlayer**                          | transport → scrub track with a marker positioned by `left` (no transition: it follows a finger) → segment list → copy affordances                                                          | none on scrub; copy gives feedback without animation (frequent action)                                     |
| **TaskProgressScale**                         | track → two-colour gradient split at `--task-progress-position` (`--green-600` done, `--red-600` left) → grab handle. Keyboard moves in the same steps as the drag snaps.                  | none: the handle follows the pointer                                                                       |
| **LandingGalleryGrid**                        | device-framed tile → `--color-paper` stage → `--shadow-stage` → caption. A rendered page is the customer's artefact and stays on paper in both themes.                                     | tile entrance only, once                                                                                   |
| **StorageChip**                               | `Badge` trigger (role by state) → `Popover` with the detail rows. Connection state is a word as well as a colour.                                                                          | none on the trigger; the popover is `frequent`                                                             |
| **Marked**                                    | `<mark>` on the matched run, `--amber-*` wash, inherits its parent's type step                                                                                                             | none                                                                                                       |
| **CodeCell / Countdown**                      | digit cells at a fixed measure → expiry ring drawn with `stroke-dasharray`                                                                                                                 | the ring is an ambient loop; copying a code is silent                                                      |
| **SotyLoader family**                         | three ribbons compressing into one (`SotyLoader`), the transcription wave (`TranscriptionLoader`), three dots (`SotyDots`)                                                                 | ambient loops, all removed under reduced motion except the spinner, which slows to `--motion-spin-reduced` |

---

## Per-component state rules

- **Disabled** never explains nothing: where a control is disabled for a reason the reader
  cannot infer, the reason is available on hover and focus.
- **Loading** replaces the label with a spinner _and keeps the control's width_, so nothing
  reflows.
- **Selected** is never colour alone — a check, a fill and a border together (FR-032).
- **Invalid** shows the message under the field, not only a red outline.
- **Focus-visible** is one ring (`--color-focus`, 2px, 2px offset) everywhere; no component
  removes it.
- **Hover** on rows in dense lists is a background change with no transition (frequent
  action).
