# Feature Specification: One Design System Across Every Screen

**Feature Branch**: `021-design-system-redesign`

**Created**: 2026-09-13

**Status**: Draft

**Input**: User description: "Redesign every screen and state of Soty against a single design system, built on the Nuxt UI component model (https://ui.nuxt.com/docs/components) and governed by the rules in DESIGN.md. Go through absolutely every screen and state we currently have and redesign them using that UI vocabulary while holding to the design rules."

## Why This Exists

Soty has grown one screen at a time. Each surface was designed when it was needed, and
each was internally coherent — but between them the product speaks several dialects:

- **Four button languages.** The tools use `.button-primary/.button-secondary/.button-ghost`;
  the team space adds `.team-agent-run-add`, `.team-accounts-fold-all` and
  `.team-empty-action`, each a hand-rolled pill with its own height, radius and hover; the
  explorer's selection bar uses `SelectionAction`; the account picker uses a fifth shape.
- **Three panel languages.** The compressor's settings slab (violet tint, accent outline),
  the team panel (surface + hairline + shadow), and the dialog card each answer "what is a
  container" differently. Feature 020 had to teach the settings dialog the compressor's
  answer by hand, panel by panel.
- **Seventeen ad-hoc type steps.** `--text-2xs` through `--text-2xl` exist, and screens
  also set `0.7rem`, `0.72rem`, `0.74rem`, `0.76rem`, `0.78rem`, `0.8rem`, `0.82rem`,
  `0.85rem` inline. Nothing says which step a caption is.
- **Colour used by name, not by meaning.** `--color-accent` (violet) and `--color-action`
  (honey) both mean "important", and which one a screen reaches for is historical. There is
  no `success`/`info`/`warning`/`error` family a component can be asked for by role.
- **Empty, loading and error states invented per screen.** Some show a skeleton, some a
  sentence, some nothing; some name the way out, some do not.
- **Animation by accident.** Durations range from 120ms to 600ms with four easing tokens,
  and `prefers-reduced-motion` is honoured in some places and not others.

The cost is paid three times: by the reader, who learns each screen separately; by the
owner, who asks for a fix on one screen and gets it only there (020 is full of such
one-screen repairs); and by every future screen, which must choose a dialect before it can
be built.

This feature replaces the dialects with one vocabulary — modelled on Nuxt UI's component
catalogue, governed by the product's own `docs/DESIGN.md` and by the craft rules in
`docs/DESIGN-PRINCIPLES.md` — and then re-dresses every screen and every state in it.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - A reader learns the product once (Priority: P1)

A media buyer who has used the compressor opens the team space for the first time. Every
control they meet there already makes sense: the primary action looks the way primary
actions looked in the compressor, a destructive action is quieter than the safe one beside
it, a panel is a panel, a caption is a caption, and a disabled control says why it is
disabled the same way everywhere.

**Why this priority**: This is the whole point. A product that reads as one product is the
outcome; everything else in this feature is the means.

**Independent Test**: Walk a person who knows one tool through a screen they have never
opened and ask them to name the primary action, the destructive action, and what is
currently selected — without touching anything. They should be right every time.

**Acceptance Scenarios**:

1. **Given** any two screens in the product, **When** they are compared side by side,
   **Then** a button of the same role has the same height, radius, type step, icon size and
   hover/active/focus behaviour on both.
2. **Given** any screen with a destructive action, **When** it is placed beside a safe one,
   **Then** the destructive one is visually de-emphasised (colour, weight and position) and
   the safe one carries the emphasis.
3. **Given** any container that holds a group of controls, **When** it is compared with a
   container of the same role elsewhere, **Then** its background, border, radius and padding
   come from the same token set.

---

### User Story 2 - Every state is designed, not left over (Priority: P1)

A member opens a space that is still indexing, a folder with nothing in it, a picker whose
dictionary is empty, a panel whose request failed, and a screen they have no access to. Each
of those five moments tells them what is true, what happens next, and — where one exists —
gives them the control that resolves it, in the same shape every time.

**Why this priority**: Loading, empty, error and permission states are where a product
either feels finished or feels abandoned, and they are where Soty is most uneven today.
They are also the states the owner keeps hitting (020: the preview chip that span forever,
the empty tag popover with no way out, the unavailable-space screen pinned to a corner).

**Independent Test**: Force each state on each screen (disconnect the agent, empty a
folder, revoke a permission, fail a request) and check it against the state checklist:
a title, one sentence of what is true, the way out if there is one, and the same anatomy as
the same state elsewhere.

**Acceptance Scenarios**:

1. **Given** any list or panel that can be empty, **When** it has nothing to show,
   **Then** it shows an empty state with a title, one explanatory sentence, and — where an
   action can fill it — a control that opens exactly the place that fills it.
2. **Given** any surface that loads data, **When** the data has not arrived,
   **Then** it shows a skeleton of the shape that is coming, not a spinner or a bare
   sentence, and the layout does not shift when the data lands.
3. **Given** any request that can fail, **When** it fails,
   **Then** the failure is stated in the reader's language with what they can do about it,
   and a retry where retrying is meaningful.
4. **Given** a control the current member's role does not permit, **When** they reach the
   screen, **Then** the control is either absent or explains who can perform it — never a
   dead button.

---

### User Story 3 - Motion that helps and never delays (Priority: P2)

Someone works through fifty files in an hour. Menus open instantly, dialogs settle without
drawing attention, nothing they do dozens of times a day waits on an animation, and a reader
who has asked their system to reduce motion gets a product that respects that.

**Why this priority**: `docs/DESIGN-PRINCIPLES.md` is unusually specific here, and the product
currently has both ends of the mistake — 600ms section transitions in one place, no
`prefers-reduced-motion` handling in another.

**Independent Test**: Record each animated transition and measure it; check every trigger
against the "frequent action" rule; run the whole product with reduced motion on.

**Acceptance Scenarios**:

1. **Given** any UI transition, **When** it is measured, **Then** it completes within
   200–300ms, and no transition exceeds 300ms except a deliberately decorative one that is
   documented as such.
2. **Given** a reader with `prefers-reduced-motion: reduce`, **When** they use any screen,
   **Then** transitions are removed or reduced to an opacity change, and no motion is
   essential to understanding what happened.
3. **Given** a popover, dropdown or tooltip, **When** it opens, **Then** it grows from its
   own trigger (correct transform origin), starting at 0.95 scale rather than 0.
4. **Given** an action a person performs many times an hour (opening a menu, toggling a
   selection, pressing a keyboard shortcut), **When** they perform it, **Then** it happens
   with no animation at all.

---

### User Story 4 - The same screen works at every width and in both themes (Priority: P2)

A member opens the same screen on a 1440px laptop, on a half-width window beside their ad
manager, and in light mode. Nothing overlaps, nothing is cut off, no text sits on a
background it cannot be read against, and the screen loses features gracefully rather than
breaking.

**Why this priority**: The owner works in a half-width window, and several 020 findings were
exactly this: buttons printing over each other, a caption cut in half by a popover edge,
violet text on a violet wash.

**Independent Test**: Every screen at 1920, 1440, 1024, 768 and 390 CSS pixels, in dark and
light, with the longest translation string in each label.

**Acceptance Scenarios**:

1. **Given** any screen at any supported width, **When** it is rendered, **Then** no element
   overlaps another, nothing is clipped, and the page does not scroll horizontally.
2. **Given** any text on any surface, **When** contrast is measured, **Then** body text
   meets 4.5:1 and large text and non-text indicators meet 3:1, in both themes.
3. **Given** a label whose translation is the longest of the supported languages, **When**
   it is rendered in its control, **Then** the control grows or wraps rather than clipping
   or overflowing.

---

### User Story 5 - A new screen is cheap to build and impossible to get wrong (Priority: P3)

Someone adds a screen six months from now. They pick components out of the inventory, use
the tokens, and get a screen that matches the product without a single new colour, radius or
duration — and without reading five existing screens to work out the convention.

**Why this priority**: The system only pays for itself if it is the path of least
resistance. This is also what stops the dialects growing back.

**Independent Test**: Build one new screen using only the inventory and tokens; count the
new CSS declarations it needed (target: near zero outside layout).

**Acceptance Scenarios**:

1. **Given** the component inventory, **When** a new screen is built from it, **Then** it
   requires no new colour, radius, shadow, type step or duration value.
2. **Given** a contributor reading the design documentation, **When** they need a control,
   **Then** the inventory names it, shows its variants and sizes, and says which state each
   variant is for.

---

### Edge Cases

- **A screen with no equivalent in the Nuxt UI catalogue.** The compressor's CRF gem, the
  honeycomb field, the power lever, the transcript editor and the landing viewer's device
  frame have no counterpart. They keep their behaviour and adopt the token layer, and the
  inventory records them as product-specific components with their own anatomy.
- **The agent is not connected.** Every tool screen has a "needs the local app" state; these
  must be one state with one anatomy, not six.
- **A translation that doubles the length of a label.** Ukrainian labels routinely run 1.4×
  the English; every control must be measured with the longer of the two.
- **A member whose role permits less than the screen offers.** Viewer, editor, admin and
  owner see different controls on the same screen; the redesign must not turn a hidden
  control into a visible-but-dead one.
- **A screen mid-migration.** Because this touches every screen, the product will spend time
  partly migrated; the token layer must be introduced so that an unmigrated screen keeps
  working and looks no worse than it does today.
- **Reduced motion plus a state that only motion communicated.** Any state a spinner or a
  slide currently communicates must also be communicated statically.
- **Dense data surfaces.** The accounts table, the explorer grid and the audit list are
  denser than any Nuxt UI example; their density must come from the size scale (xs/sm) and
  not from one-off values.

## Requirements _(mandatory)_

### A. Token layer

- **FR-001**: The product MUST define one token layer that every screen reads from, covering
  colour, type, space, radius, shadow, motion, and z-layer. No screen may introduce a raw
  value for any of these.
- **FR-002**: Colour MUST be addressable by role, not by hue: `primary`, `secondary`,
  `success`, `info`, `warning`, `error`, `neutral`. Each role MUST carry the shades a
  component needs (solid, hover, active, soft, softer, on-colour, border) in both themes.
- **FR-003**: The existing brand hues MUST map into the roles rather than being replaced:
  violet as `primary`, honey as `secondary`, with the current success/warning/error hues
  retained. The product's identity MUST NOT change; only its vocabulary.
- **FR-004**: The type scale MUST be a single named ramp, and every existing inline size
  (0.7rem through 0.85rem and friends) MUST resolve to one of its steps. Each step MUST
  have a documented role (display, title, body, caption, micro).
- **FR-005**: Radius MUST follow the nesting rule from `docs/DESIGN-PRINCIPLES.md`: an outer radius is
  twice its inner radius. The scale MUST name which radius belongs to which container size.
- **FR-006**: Motion MUST expose one duration set with a 300ms ceiling and one easing set
  built from custom `cubic-bezier` curves — `ease-out` for entering and leaving, and
  `ease-in-out` reserved for elements already on screen.
- **FR-007**: Both themes MUST be complete: every token MUST have a value in dark and light,
  and no screen may define a colour that exists in only one theme.

### B. Component inventory

- **FR-008**: The product MUST have a named component inventory, mapped onto the Nuxt UI
  catalogue, covering at minimum: Button, Badge, Chip, Card, Alert, Avatar, Separator,
  Progress, Skeleton, Kbd, Collapsible, FieldGroup, Input, InputNumber, Select, SelectMenu,
  Checkbox, RadioGroup, Switch, Slider, Textarea, FormField, Form, Table, Accordion, Empty,
  Tree, Timeline, Breadcrumb, Link, NavigationMenu, Pagination, Tabs, CommandPalette,
  ContextMenu, DropdownMenu, Modal, Drawer/Slideover, Popover, Toast, Tooltip.
- **FR-009**: Every interactive component MUST accept the same variant vocabulary —
  `solid`, `outline`, `soft`, `subtle`, `ghost`, `link` — and the same size scale —
  `xs`, `sm`, `md`, `lg`, `xl` — with documented defaults.
- **FR-010**: Every interactive component MUST define all of its states: rest, hover,
  active, focus-visible, disabled, loading, and (where it holds a value) selected and
  invalid. A state that is not visually distinct from another state is a defect.
- **FR-011**: Focus MUST be visible on every interactive element, with one focus treatment
  across the product, and MUST never be removed without an equivalent replacement.
- **FR-012**: Icon-only controls MUST carry an accessible name and, wherever space allows, a
  visible label; where a label cannot fit, the control MUST offer its name on hover and on
  keyboard focus.
- **FR-013**: The inventory MUST record the product-specific components that have no Nuxt UI
  counterpart, with the same rigour: anatomy, variants, sizes, states.
- **FR-014**: Every component in the inventory MUST be demonstrable in isolation, with all
  of its variants, sizes and states visible on one page, so a regression is visible without
  hunting through the product.

### C. Screens and states

- **FR-015**: Every route the product can show MUST be redesigned against the inventory:
  public home, login, privacy, terms, auth callback, auth handoff, tools home, compressor,
  stitcher, transcription, landing optimizer, 2FA notebook, landing preview viewer, account,
  admin, and the team space in all of its sections.
- **FR-016**: Every non-route state MUST be redesigned with it: auth loading, auth recovery,
  blocked account, deleted account, configuration error, session handoff, onboarding, and
  the local-app-required state.
- **FR-017**: Each screen MUST be specified state by state: initial, loading, empty,
  populated, partially-failed, failed, permission-limited, and offline/agent-missing where
  they apply.
- **FR-018**: The team space MUST be covered in full: lobby, explorer (list and grid, folder
  tree, selection bar, trash), tasks (board, card, editor, filters), accounts (table, group,
  row, money, tags, markers), members, the settings dialog and each of its five tabs, the
  material preview, the landing full view, and every picker and confirmation dialog.
- **FR-019**: Cross-cutting surfaces MUST be redesigned once and reused: the top bar and its
  controls, the storage chip, the support dialog, toasts, modals and their backdrop, empty
  states, skeletons, error banners, selection bars, and the release update notice.
- **FR-020**: Destructive actions MUST be de-emphasised relative to safe actions on every
  screen, and MUST require confirmation that names the consequence in a verb — never
  "Yes/No" — with undo wherever the action can be undone.
- **FR-021**: Every empty state that can be resolved by an action MUST offer that action as
  a control, not as a sentence describing where to go.
- **FR-022**: Every screen MUST state its primary action unambiguously: exactly one
  `primary`-variant control per surface, positioned at the end of the reading flow.
- **FR-023**: Text measure MUST be bounded: no paragraph may run wider than roughly 70
  characters regardless of container width.

### D. Motion

- **FR-024**: No transition may exceed 300ms; the default MUST be 200ms with `ease-out`.
- **FR-025**: Only `transform`, `opacity` and `filter` may be animated. Layout-affecting
  properties MUST NOT be transitioned.
- **FR-026**: Overlays MUST animate from their trigger's position, starting from 0.95 scale;
  animating from zero scale is prohibited.
- **FR-027**: Actions performed many times per session — opening menus, toggling selection,
  keyboard shortcuts, hovering rows in a list — MUST NOT animate.
- **FR-028**: `prefers-reduced-motion: reduce` MUST disable or reduce every transition in the
  product, and MUST be verified on every screen.
- **FR-029**: Interactive controls MUST give tactile feedback on press (a 0.97 scale on
  `:active`), except those excluded by FR-027.
- **FR-030**: An interrupted transition MUST continue from its current position rather than
  restarting or completing the previous one.

### E. Accessibility and internationalisation

- **FR-031**: Contrast MUST meet WCAG AA (4.5:1 body, 3:1 large text and UI indicators) on
  every surface in both themes.
- **FR-032**: State MUST never be communicated by colour alone; a second signal — icon,
  shape, text or position — MUST accompany it.
- **FR-033**: Every screen MUST be operable by keyboard alone, with a visible focus path
  that follows the reading order, and dialogs MUST trap focus and restore it on close.
- **FR-034**: Every label, empty state, error and confirmation introduced or rewritten by
  this work MUST exist in both supported languages, and every control MUST be verified with
  the longer translation.

### F. Migration discipline

- **FR-035**: The token layer MUST be introduced before any screen is redesigned, and MUST
  be adopted by the existing stylesheet so that unmigrated screens inherit it unchanged.
- **FR-036**: Each screen's redesign MUST be independently shippable: at no point may the
  product be left in a state where a screen is half-migrated.
- **FR-037**: Behaviour MUST NOT change. This work moves no logic, adds no capability and
  removes none; where a screen's behaviour is wrong, that is recorded as a separate finding
  rather than fixed silently inside a redesign.
- **FR-038**: Existing automated tests MUST keep passing. Where a test asserts on a class
  name or a visual detail the redesign changes, the test MUST be updated to assert the same
  behaviour through a role or an accessible name.
- **FR-039**: The design documentation — `docs/DESIGN.md` (the product's own rules),
  `docs/DESIGN-PRINCIPLES.md` (the craft reference) and the inventory — MUST be the reference
  a contributor is pointed at, and MUST be updated in the same change as any addition to the
  system.
- **FR-040**: The component inventory MUST encode the rules already written in
  `docs/DESIGN.md` rather than restating or contradicting them: lucide icons at
  `ICON_SIZE`/`ICON_STROKE`, the picto-group anatomy and its `is-selected` state, inline
  fields with the unit outside the border and a 72–150px width, validation that appears only
  after invalid input, the left-shelf grouping of settings, and the 30×30 / 44×38 icon
  plates. Where a rule there and a Nuxt UI default disagree, the rule wins and the inventory
  records why.

### Key Entities

- **Token**: A named design decision (colour role and shade, type step, space step, radius,
  shadow, duration, easing, layer) with a value per theme. The single source for its kind of
  value.
- **Component**: A named, reusable control or container with a documented anatomy, a variant
  set, a size set, and a complete state set. Either mapped to a Nuxt UI counterpart or
  recorded as product-specific.
- **Screen**: A route or overlay the product can show, with an enumerated set of states.
- **State**: One condition a screen or component can be in (initial, loading, empty,
  populated, failed, permission-limited, disabled, selected, invalid), each with its own
  designed appearance.
- **Pattern**: A composition of components that recurs across screens (empty state,
  confirmation dialog, selection bar, settings panel, picker, data table row), specified
  once and reused.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Every screen and state enumerated in FR-015 to FR-019 is redesigned and
  reviewed against the inventory — 100%, with none deferred.
- **SC-002**: Zero raw colour, radius, shadow, duration or type values remain in screen-level
  styles; every such value resolves to a token.
- **SC-003**: A control of a given role is visually identical across every screen it appears
  on, verified by comparing rendered measurements (height, radius, type step, icon size) —
  no more than one variant per role survives.
- **SC-004**: Every screen passes the state checklist for each state it can enter: a title,
  one sentence, the way out where one exists.
- **SC-005**: No transition in the product exceeds 300ms, and every screen behaves correctly
  under reduced motion.
- **SC-006**: Contrast checks pass at WCAG AA on every surface in both themes, with zero
  failures.
- **SC-007**: Every screen renders without overlap, clipping or horizontal scroll at 1920,
  1440, 1024, 768 and 390 CSS pixels, in both themes, with the longest translations.
- **SC-008**: A person who knows one screen can name the primary action, the destructive
  action and the current selection on a screen they have never seen, correctly, on first
  look.
- **SC-009**: A new screen built from the inventory needs no new token and no new component
  variant.
- **SC-010**: The full automated test suite passes, with no behavioural test weakened to
  accommodate the redesign.

## Assumptions

- **Nuxt UI is a reference, not a dependency.** It is a Vue library; Soty's web app is React
  with one global stylesheet (constitution VI). This work adopts Nuxt UI's component
  catalogue, naming, variant and size vocabulary, and component anatomy — and implements
  them in the existing React + CSS-custom-property seams. No Vue, no Tailwind, no new
  runtime dependency.
- **The brand stays.** Violet and honey remain the product's colours, the honeycomb field
  and the logo are untouched. This is a systematisation, not a rebrand.
- **Behaviour is frozen.** Every screen keeps what it does. Findings about behaviour are
  recorded for later work rather than folded into a redesign commit.
- **Dark theme is the primary.** Light theme is fully supported and verified, but where a
  decision favours one, dark wins — it is what the product ships in and what the owner uses.
- **Supported widths are 390px and up.** The product targets desktop and half-width desktop
  windows; a phone-width layout must not break, but it is not the design target.
- **Two languages.** Ukrainian and English, with Ukrainian typically the longer.
- **Density matters more than air.** This is a working tool used for hours at a time, not a
  marketing site; where Nuxt UI's defaults are roomier than the product needs, the smaller
  sizes of the same scale are used rather than new values.
- **The agent's own UI is in scope** only where it is served through the web app; the
  packaged desktop shell's native chrome is not.
- **Two design documents, both authoritative, in this order.** `docs/DESIGN.md` is the
  product's own rule book, written by the owner: lucide icons at 20/1.75, picto groups and
  their `is-selected` state, inline fields with the unit outside the border, validation that
  appears only after invalid input, left-shelf setting groups, red for destructive and green
  for positive, 30×30 and 44×38 icon plates. Those rules describe this product and win.
  `docs/DESIGN-PRINCIPLES.md` is the general craft reference (UI/UX from uidesign.tips,
  animation from animations.dev and emilkowal.ski) and wins over Nuxt UI's defaults —
  notably on duration, easing and when not to animate at all. Nuxt UI supplies the catalogue
  and the vocabulary, and yields to both.
