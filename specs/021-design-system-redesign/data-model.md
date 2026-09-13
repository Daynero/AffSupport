# Phase 1 Data Model: Design System Entities

**Feature**: 021-design-system-redesign | **Date**: 2026-09-13

This feature stores no data. Its "model" is the vocabulary the product is built from: tokens,
components, patterns, screens and states. Each entity below has a name, attributes, and rules
that make an instance valid — the same discipline a database entity gets, because these are
what the implementation will be checked against.

---

## Entity: Token

A named design decision. The only place a raw value may appear.

| Attribute | Type | Rule |
|---|---|---|
| `name` | kebab custom property | `--<family>-<role>[-<modifier>]`, e.g. `--color-primary-soft` |
| `family` | enum | `color` \| `text` \| `space` \| `radius` \| `shadow` \| `motion` \| `layer` |
| `role` | string | the meaning, never the appearance (`primary`, not `violet`) |
| `dark` | value | required |
| `light` | value | required |

**Validation rules**

- Every token has a value in both themes (FR-007). A token defined in one theme only is invalid.
- No token references a hue name in its own name.
- Colour tokens that pair as foreground/background declare their pair, and the pair meets AA.
- Motion durations are ≤ 300ms (FR-024).

**Families and members**

*Colour* — seven roles × the shades a component needs:

| Role | Source hue today | Shades |
|---|---|---|
| `primary` | `--purple-*` (violet) | `solid`, `hover`, `active`, `soft`, `softer`, `border`, `text`, `on-solid`, `50…950` |
| `secondary` | `--honey-*` | same set |
| `success` | existing green | `solid`, `soft`, `border`, `text`, `on-solid` |
| `info` | task-tag blue | same |
| `warning` | existing amber | same |
| `error` | existing red | same |
| `neutral` | surface/text ramp | `bg`, `surface`, `surface-raised`, `surface-subtle`, `surface-muted`, `border`, `border-strong`, `text`, `text-muted`, `50…950` |

*Text* — one ramp, each step with a role: `display` (page title), `title` (panel heading),
`section` (group heading), `body` (default), `label` (control label), `caption` (helper),
`micro` (table caption, badge). Values are the existing `--text-*` ladder.

*Space* — `1`–`6` as today (4/8/12/16/20/24px), plus `0` and `px`.

*Radius* — `sm` (6), `md` (10), `lg` (14), `xl` (18), `full` (999). The nesting rule from
DESIGN.md holds: an outer container's radius is twice its inner's, so a `md` control inside an
`xl` card is correct and an `xl` control inside an `xl` card is not.

*Shadow* — `sm`, `md`, `lg`, `menu`. Used sparingly; the product separates surfaces by tint,
not by elevation.

*Motion* — `fast` (150ms), `base` (220ms), `slow` (300ms, ceiling); `ease-out`,
`ease-in-out`, `linear`. Under `prefers-reduced-motion: reduce` all three durations resolve
to `1ms`.

*Layer* — the existing `--layer-*` set, unchanged in values, documented in one place.

---

## Entity: Component

A named control or container with a documented anatomy.

| Attribute | Type | Rule |
|---|---|---|
| `name` | PascalCase | matches its Nuxt UI counterpart where one exists |
| `origin` | enum | `nuxt-mapped` \| `product-specific` |
| `anatomy` | list of parts | each part named (root, leading icon, label, trailing icon, indicator) |
| `colors` | subset of roles | which of the seven it accepts |
| `variants` | subset | of `solid`, `outline`, `soft`, `subtle`, `ghost`, `link` |
| `sizes` | subset | of `xs`, `sm`, `md`, `lg`, `xl` |
| `states` | set | rest, hover, active, focus-visible, disabled, loading, selected, invalid — those that apply |
| `defaults` | record | the colour, variant and size used when none is given |

**Validation rules**

- Every state that applies is visually distinct from every other (FR-010).
- `focus-visible` is present on every interactive component and uses the one product-wide
  treatment (FR-011).
- `disabled` is distinguishable from `loading`: loading implies work in flight, disabled
  implies unavailable.
- An icon-only instance carries an accessible name (FR-012).
- No component introduces a value outside the token set.

**Inventory** — see `contracts/components.md` for the full table. Counts: 33 mapped onto
Nuxt UI, 12 product-specific.

---

## Entity: Pattern

A composition of components that recurs and is specified once.

| Pattern | Composition | Used by |
|---|---|---|
| Empty state | icon + title + one sentence + optional action | every list, picker, panel |
| Loading state | skeleton of the shape that is coming | every data surface |
| Error state | alert (`error`, `soft`) + cause + retry where meaningful | every request path |
| Permission-limited state | the control's absence, or an explanation naming who can act | every role-gated surface |
| Confirmation dialog | modal + consequence sentence + verb button (`error`, de-emphasised) + cancel | every destructive action |
| Selection bar | count + actions + clear (`Clear selection (N)`) | explorer, tools, library |
| Settings panel | card + icon heading + summary + body | settings dialog, compressor, transcription |
| Picker dialog | modal + search + breadcrumb + list + footer actions | accounts, attachments, folders |
| Data table row | row + leading identity + columns + trailing actions | accounts, members, audit, invitations |
| Chip row | chips (`xs`, `soft`) + add control | tags, agent labels, filters |

**Validation rules**

- A screen may not invent a variant of a pattern; if it needs one, the pattern changes and
  every user of it follows.
- Every pattern has a defined behaviour under reduced motion.

---

## Entity: Screen

A route or overlay, with the set of states it can enter.

| Attribute | Type |
|---|---|
| `id` | stable slug, e.g. `team.explorer` |
| `route` | path or "overlay over X" |
| `group` | migration group C1–C14 |
| `states` | subset of the State entity below |
| `roleVariants` | which member roles see a different surface |

The full enumeration — 15 routes, 9 system states, ~40 overlays — is in
`contracts/screens.md`. Each row names the states that screen can enter, which is what the
tasks are generated from.

---

## Entity: State

One condition a screen or component can be in.

| State | Means | Must show |
|---|---|---|
| `initial` | first paint, nothing requested yet | the shell, not a spinner |
| `loading` | request in flight | a skeleton matching the coming shape |
| `empty` | request succeeded, nothing to show | title, one sentence, the way out if one exists |
| `populated` | the normal case | the content |
| `partial` | some of it failed | what arrived, plus what did not and why |
| `failed` | the request failed | cause in the reader's language + retry where meaningful |
| `permission-limited` | the role may not act | no dead controls; who can act, if it helps |
| `offline` | the local agent is required and absent | what needs the agent and how to get it |
| `busy` | an action is running on this surface | progress, and a way to stop where stopping is safe |

**Validation rules**

- A screen's state set is closed: every state it can enter is enumerated and designed.
- `empty` and `failed` are never the same treatment.
- `offline` is one pattern across all six tools, not six.
- No state is communicated by motion alone (FR-028 interaction).

---

## Relationships

```text
Token ──used by──> Component ──composed into──> Pattern ──arranged into──> Screen
                        │                                        │
                        └────────── has ──> State <── enumerates ┘
```

- A Component may not reference a raw value; only Tokens.
- A Pattern may not introduce a Component; only compose existing ones.
- A Screen may not introduce a Pattern; if it needs one, it is added to the Pattern set and
  becomes available to every screen.
- A State's appearance is defined once at the Pattern level and inherited by every Screen
  that enters it.

## State transitions worth designing

These are the transitions the reader actually sees, and each has a defined motion treatment
(all within the 300ms ceiling, all `transform`/`opacity` only):

- `loading → populated`: skeleton cross-fades to content; no layout shift, because the
  skeleton has the content's dimensions.
- `loading → empty`: skeleton fades out, empty state fades in.
- `populated → busy`: the acting control enters its `loading` state; the surface does not
  move.
- `any → failed`: the alert appears in place, above the content it concerns; the content
  stays.
- `closed → open` (overlay): scale 0.95 → 1 with opacity, from the trigger's origin.
- `unselected → selected`: no animation (frequent action).
