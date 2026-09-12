# Contract: The Token Layer

**Feature**: 021-design-system-redesign | **File**: `apps/web/src/styles/tokens.css`

Every value in the product resolves to one of these. A screen that needs a value not listed
here changes this contract first.

## Rules

1. Both themes, always. A token with a value in one theme only is invalid.
2. Names carry meaning, not appearance: `--color-primary-solid`, never `--color-violet-600`.
3. Raw hues (`--purple-*`, `--honey-*`) exist only as the palette the roles are built from,
   and may not be referenced outside this file.
4. Every legacy custom property is redefined here as an alias, so unmigrated screens inherit
   the system untouched.

## Colour roles

| Token | Role | Dark | Light |
|---|---|---|---|
| `--color-primary-solid` | the one action a surface exists for | `--purple-500` | `--purple-600` |
| `--color-primary-hover` | its hover | `--purple-400` | `--purple-500` |
| `--color-primary-active` | its press | `--purple-300` | `--purple-700` |
| `--color-primary-soft` | selected rows, active tabs, washes | `purple 18%` over surface | `purple 12%` over white |
| `--color-primary-softer` | the quietest wash | `purple 10%` | `purple 7%` |
| `--color-primary-border` | outline variant, focused field | `purple 45%` | `purple 30%` |
| `--color-primary-text` | link, ghost label | `--purple-300` | `--purple-700` |
| `--color-primary-on-solid` | text on a solid primary | near-white | white |
| `--color-secondary-*` | the same eight, from honey | | |
| `--color-success-*` | done, connected, free | existing green | |
| `--color-info-*` | neutral notice, help | task-tag blue | |
| `--color-warning-*` | attention needed, pending | existing amber | |
| `--color-error-*` | failure, destructive | existing red | |
| `--color-neutral-bg` | the page | `#120f17` | near-white |
| `--color-neutral-surface` | a card | `#1c1725` | white |
| `--color-neutral-surface-raised` | a dialog over a card | +2 steps | +shadow |
| `--color-neutral-surface-subtle` | a well inside a card | −1 step | −1 step |
| `--color-neutral-surface-muted` | a chip's ground | +1 step | +1 step |
| `--color-neutral-border` | hairline | 14% text | 12% text |
| `--color-neutral-border-strong` | field outline | 24% text | 20% text |
| `--color-neutral-text` | body | near-white | near-black |
| `--color-neutral-text-muted` | caption | 62% | 55% |
| `--color-focus` | the one focus ring | primary at 70% | primary |
| `--color-overlay` | modal backdrop | black 62% | black 38% |

**Declared pairs that must meet AA** (checked by `tests/design-tokens.test.ts`):
text-on-bg, text-muted-on-bg, text-on-surface, text-muted-on-surface, on-solid-on-solid for
all seven roles, role-text-on-soft for all seven roles, border-strong-on-surface (3:1).

## Type ramp

| Token | Role | Size |
|---|---|---|
| `--text-display` | page title | 1.87rem |
| `--text-title` | panel heading | 1.49rem |
| `--text-section` | group heading | 1.31rem |
| `--text-body` | default | 1.03rem |
| `--text-label` | control label | 0.93rem |
| `--text-caption` | helper, meta | 0.84rem |
| `--text-micro` | table caption, badge | 0.69rem |

Weights: 400 body, 600 label/emphasis, 700 headings. Line heights: 1.2 headings, 1.45 body,
1.35 caption. Measure: paragraphs capped at 70ch (FR-023).

## Space, radius, shadow

`--space-0/px/1/2/3/4/5/6` = 0/1/4/8/12/16/20/24px — unchanged values.
`--radius-sm/md/lg/xl/full` = 6/10/14/18/999px — unchanged values, with the 2× nesting rule.
`--shadow-sm/md/lg/menu` — unchanged; elevation is the exception, tint is the rule.

## Motion

| Token | Value | For |
|---|---|---|
| `--motion-fast` | 150ms | hover, press, selection feedback |
| `--motion-base` | 220ms | enter/leave, dialogs, popovers, accordions |
| `--motion-slow` | 300ms | ceiling; only for a transition that moves a whole region |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | default — entering and leaving |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | elements already on screen |
| `--ease-linear` | `linear` | progress only |

```css
@media (prefers-reduced-motion: reduce) {
  :root { --motion-fast: 1ms; --motion-base: 1ms; --motion-slow: 1ms; }
}
```

Animatable properties: `transform`, `opacity`, `filter`, and the colour properties
(`color`, `background-color`, `border-color`, `box-shadow`). Everything else is prohibited.

## Layers

`--layer-base/raised/content/sticky/header/dropdown/popover/overlay/modal/modal-nested/
preview/tooltip/toast/top` — existing values, documented here as the single ordering.

## Legacy aliases (Phase A2)

Every property the current stylesheet uses is redefined in terms of the above:
`--color-accent*` → primary, `--color-action*` → secondary, `--color-surface*` → neutral,
`--color-text*` → neutral, `--color-warning*`/`--color-error*` → their roles,
`--text-2xs…--text-17xl` → the nearest ramp step, `--dur-*` → motion (values over 300ms snap
to `--motion-slow`), `--ease-*` → the two curves.
