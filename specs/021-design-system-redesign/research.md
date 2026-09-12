# Phase 0 Research: One Design System Across Every Screen

**Feature**: 021-design-system-redesign | **Date**: 2026-09-13

Every question this feature could have left open is answered here, because the owner asked
for decisions rather than questions. Each entry records what was chosen, why, and what was
rejected.

---

## R1 — How a Vue component library becomes a React product's vocabulary

**Decision**: Adopt Nuxt UI's *catalogue, naming, prop model and anatomy*; implement in
React with plain CSS. Nothing from the library is installed.

**Rationale**: Constitution VI fixes the web app as function components, one global
stylesheet, `className` strings, theming through CSS custom properties and `data-theme`, and
no data or styling library. Nuxt UI is Vue + Tailwind v4 + Reka UI — none of which can enter
this codebase. What is portable is the part that actually causes the product's problem: a
settled answer to "what components exist, what are they called, and what props do they
take". Its model is unusually clean — `color` × `variant` × `size` on every component, seven
semantic colours, six variants, five sizes — and it maps onto CSS custom properties without
loss.

**Alternatives considered**:
- *Install a React equivalent (shadcn/ui, Radix, Ark).* Rejected: contradicts constitution
  VI, adds a dependency tree to a product whose whole pitch is that it is small and local,
  and would rewrite behaviour while claiming to restyle it.
- *Invent a bespoke system from the existing screens.* Rejected: the existing screens are the
  problem; a system distilled from them inherits the disagreements. An outside reference
  settles arguments that have no local answer.
- *Port Nuxt UI's Tailwind classes into the stylesheet.* Rejected: utility classes fight the
  one-stylesheet, semantic-class idiom the codebase uses everywhere.

---

## R2 — Semantic colour roles over brand hues

**Decision**: Seven roles — `primary`, `secondary`, `success`, `info`, `warning`, `error`,
`neutral` — each with the shades a component needs. Violet (`--purple-*`) becomes `primary`;
honey (`--honey-*`) becomes `secondary`; existing green/amber/red become `success`/`warning`/
`error`; `info` takes the blue already used by task tags; `neutral` takes the surface and
text ramp.

**Rationale**: The product currently has two "important" colours — accent (violet) and action
(honey) — and which one a control uses is historical rather than meaningful. Roles make the
question answerable: the one action a surface exists for is `primary`; a second, weaker
action is `secondary`; a destructive one is `error` and is *de-emphasised* per DESIGN.md.
The brand is unchanged; only the reason for reaching for a colour is.

**Alternatives considered**:
- *Keep `accent`/`action` and document when to use each.* Rejected: it has been documented in
  comments for a year and the drift continued, because the names carry no rule.
- *Collapse to one brand colour.* Rejected: the honey CTA is part of the product's look and
  the owner's screenshots.

**Shade set per role**: `-50…-950` is not required for every role; components need
`solid`, `solid-hover`, `solid-active`, `soft`, `softer`, `border`, `text`, `on-solid`.
Full 50–950 ramps are kept for `primary`, `secondary` and `neutral`, which need tints for
washes and surfaces.

---

## R3 — Variants and sizes

**Decision**: `solid | outline | soft | subtle | ghost | link` and `xs | sm | md | lg | xl`,
exactly as Nuxt UI names them, on every control that can take them. Defaults: `solid`, `md`.

**Rationale**: The product already has all six variants — it just calls them
`button-primary`, `button-secondary`, `button-ghost`, `team-agent-run-add` (an outline pill),
`team-empty-action` (another outline pill), `text-button` (a link), `settings-collapse` (a
ghost row). Naming them by variant turns seven bespoke classes into one component.

**Size mapping for existing controls**: chips and dense table controls → `xs`; row actions
and filters → `sm`; the default control → `md`; dialog primary actions → `lg`; the tool-card
call to action → `xl`. The existing 44px control floor becomes `md`; `xs`/`sm` are what dense
surfaces (accounts table, explorer rows) use instead of one-off heights.

**Alternatives considered**:
- *Fewer variants (solid/outline/ghost).* Rejected: `soft` and `subtle` are what the product
  uses for chips, badges and selected states, and folding them into `outline` would flatten
  distinctions that carry meaning.

---

## R4 — Type ramp

**Decision**: One ramp with named roles. Keep the existing `--text-*` step values (they are a
tuned 1.08 ratio scale) and give each step a role: `display`, `title`, `section`, `body`,
`label`, `caption`, `micro`. Every inline `0.7rem`–`0.85rem` resolves to the nearest step.

**Rationale**: The scale is not the problem — the fifteen inline values that bypass it are.
Retaining the values keeps every migrated screen visually stable; adding roles makes the next
screen answerable without measuring an existing one.

**Alternatives considered**:
- *Adopt Tailwind's `text-xs…text-3xl` scale.* Rejected: it would resize every screen in the
  product for no gain, and the existing ratio is deliberately tighter — this is a dense tool.

---

## R5 — Motion

**Decision**: Two durations in normal use — `--motion-fast: 150ms` (hover, press, selection)
and `--motion-base: 220ms` (enter/leave, dialogs, popovers) — with `--motion-slow: 300ms` as
a documented ceiling for the rare larger transition. Easing: `--ease-out:
cubic-bezier(0.16, 1, 0.3, 1)` as the default, `--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)`
for elements already on screen, `linear` for progress only. Reduced motion neutralises all of
them in one place.

**Rationale**: `docs/DESIGN-PRINCIPLES.md` is explicit: 200–300ms, `ease-out` by default, custom
`cubic-bezier` over the CSS keywords, `ease-in-out` only for on-screen movement, and
`transform`/`opacity` only. The product today has `--dur-micro` through `--dur-complete` with
values up to 600ms — over the ceiling — and four easings including the weak built-ins.

**Not animated at all** (DESIGN.md's "frequent actions" rule): opening the kind/sort/row
menus, toggling a row's selection, the explorer's row hover, keyboard shortcuts, the theme
toggle, and the tag popover — all of them things done dozens of times an hour.

**Alternatives considered**:
- *A spring library for organic motion.* Rejected: new dependency for decorative gain;
  DESIGN.md reserves springs for decorative interactions, of which this product has few.

---

## R6 — Where the component boundary sits

**Decision**: One component per *family* file (`Button.tsx`, `Field.tsx`, `Overlay.tsx`, …)
under `components/ui/`, with `components/ui.tsx` re-exporting them so no existing import
breaks.

**Rationale**: The codebase imports `{ Button, IconButton, Checkbox } from '../components/ui'`
in ~60 files. Keeping that path working means the inventory can land before any screen
changes, and screens migrate on their own schedule. Family files (rather than one file per
component) match the existing `ui.tsx` habit and keep related variants honest about sharing
styles.

**Alternatives considered**:
- *One file per component.* Rejected: 45 files for a product this size fragments related
  styling decisions (Checkbox and Switch share nearly everything).
- *Keep everything in `ui.tsx`.* Rejected: it is already the kind of multi-responsibility
  file the constitution names as a debt.

---

## R7 — How screens migrate without a half-migrated product

**Decision**: Token aliasing first (Phase A2). Every existing custom property is redefined in
terms of the new tokens, so an untouched screen renders from the new system immediately.
Screens then migrate group by group, each group self-contained and shippable.

**Rationale**: The alternative — migrating screens one at a time while the old and new token
sets coexist — guarantees a period where two systems are live and a shared class means
different things on different screens. Aliasing inverts it: the system is live everywhere
from day one, and each group's migration is a *cleanup* (replace bespoke classes with
inventory components), not a switch-over.

**Consequence to accept**: a handful of screens will change appearance slightly the moment
the aliases land — specifically, any transition currently over 300ms, and any colour that was
using a hue outside the role set. Both are corrections the spec asks for.

---

## R8 — Verifying "one dialect" mechanically

**Decision**: A `scripts/check-design-tokens.mjs` check in `verify`, plus a token/contrast
test. The script fails on: a hex or `rgb()`/`hsl()` literal outside `tokens.css`; a `ms`/`s`
duration literal outside `tokens.css`; a `px` radius outside `tokens.css`; a `rem` font-size
outside the ramp; and a `transition` on a property other than `transform`, `opacity`,
`filter`, `color`, `background-color`, `border-color` or `box-shadow`.

**Rationale**: SC-002 and SC-003 are otherwise unverifiable on a 24,000-line stylesheet, and
the dialects grew precisely because nothing said no. The colour/background/border exceptions
are allowed because they do not affect layout and the product's hover states depend on them.

**Alternatives considered**:
- *Stylelint with a config.* Rejected: a new dependency and a config language to learn, for a
  rule set this small and this project-specific.
- *Review discipline alone.* Rejected: that is what produced the current state.

---

## R9 — The demo surface

**Decision**: A `/design` route rendering every component, variant, size and state, gated to
development builds the way existing dev-only surfaces are.

**Rationale**: FR-014 asks for a place where a regression is visible without hunting. It is
also the fastest way to verify the reduced-motion and light-theme requirements — one page
instead of fifteen routes.

**Alternatives considered**:
- *Storybook.* Rejected: a large dependency and a second build for a product with one
  stylesheet and a deliberately small toolchain.
- *A markdown reference only.* Rejected: prose does not catch a broken focus ring.

---

## R10 — Product-specific components

**Decision**: Twelve components have no Nuxt UI counterpart and keep their own anatomy:
`DropZone`, `HoneycombField`, `PowerLever` / `PowerReadout` / `PowerThrottle`, the CRF pixel
gem, `JobRow`, `TranscriptPlayer`, `TaskProgressScale`, `LandingGalleryGrid`, `StorageChip`,
`Marked`, `CodeCell` / `Countdown`, and the `SotyLoader` family. They adopt tokens and state
rules; their behaviour and shape are untouched.

**Rationale**: These are where the product is itself. Forcing them into a generic component
would cost identity for no consistency gain — nothing else in the product looks like them, so
nothing else disagrees with them.

---

## R11 — What happens to the four existing CSS modules

**Decision**: `landing-viewer.css`, `team-accounts.css`, `team-tasks.css` and
`transcription.css` stay as modules and are migrated with their screen groups (C6, C12, C11,
C5 respectively). `styles.css` keeps the shared and screen-level rules and shrinks as groups
land.

**Rationale**: They already follow the "one stylesheet, split into modules" shape the
constitution allows, and they map cleanly onto screen groups, so each group's migration has a
natural boundary.

---

## R12 — Testing strategy for a redesign

**Decision**: Three layers. (1) Token tests — completeness per theme, contrast pairs.
(2) Component tests — every variant and size renders, accessible name present, disabled and
loading visually and semantically distinct, keyboard operable. (3) Existing screen tests —
kept, and rewritten where they assert on a class name, to assert through role/accessible name
instead.

**Rationale**: FR-038 forbids weakening behavioural tests to accommodate the redesign, and
class-name assertions are the ones that will break. Rewriting them to roles makes them
stronger and immune to the next restyle.

**Explicitly not done**: screenshot/visual-regression testing. It needs infrastructure this
project does not have, and the demo route plus the five-width manual pass covers the same
ground at this scale.


---

## R13 — Two design documents, and which one wins

**Decision**: `docs/DESIGN.md` (the product's own rules, written by the owner) is the first
authority; `docs/DESIGN-PRINCIPLES.md` (the craft reference — uidesign.tips for UI/UX,
animations.dev and emilkowal.ski for motion) is the second; Nuxt UI's defaults are the third
and yield to both.

**Rationale**: They answer different questions and only appear to overlap. `DESIGN.md` is
specific to Soty and already describes patterns the product ships: lucide at 20/1.75 with
"grow the plate, never shrink the icon", the picto-group anatomy with `is-selected` (and the
explicit note that `is-active` does not exist in this system), inline fields with the unit
*outside* the border at 72–150px, validation shown only after invalid input, settings as left
shelves rather than half-empty grid columns, red for destructive and green for positive, and
30×30 / 44×38 icon plates. None of that is in a general reference, and all of it is the
product's identity. `DESIGN-PRINCIPLES.md` answers what `DESIGN.md` is silent on — duration
ceilings, easing curves, when not to animate, measure, hierarchy, empty states.

**Consequence for the inventory**: the picto RadioGroup variant, the inline-field-with-suffix
anatomy, and the icon-plate sizes are not inventions of this feature — they are `DESIGN.md`
rules that the inventory must encode so that using the inventory is the same thing as
following them. FR-040 makes that checkable.

**Alternatives considered**:
- *Merge the two into one document.* Rejected: one is the owner's product rule book and the
  other is a curated external reference with attribution to its sources; merging would blur
  which statements are Soty's own decisions.
- *Treat the general reference as authoritative.* Rejected: it would overrule concrete, tested
  decisions about this product with generic advice.
