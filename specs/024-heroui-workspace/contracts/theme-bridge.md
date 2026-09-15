# Contract: the theme bridge

**Feature**: 024-heroui-workspace
**Files**: `apps/web/src/styles/tokens.css` (the HeroUI half), `apps/web/src/styles/tailwind.css`
(the utility half)

HeroUI v3 is themed entirely by CSS custom properties declared on `:root` and on
`[data-theme="…"]` — the exact mechanism this product already uses. So the library is not
configured; it is **fed Soty's tokens**. Nothing in the app writes a HeroUI variable except this
bridge.

---

## Half 1 — HeroUI variables, in `tokens.css`

Placed after the Soty role definitions in each theme block, so it reads roles that are already
declared. Because the roles themselves flip under `:root[data-theme='dark']`, the bridge is
written **once** for values that are role-derived, and only twice where HeroUI needs a genuinely
different value per theme.

### Base surfaces and ink

| HeroUI variable | Soty source |
|---|---|
| `--background` | `--color-neutral-bg` |
| `--foreground` | `--color-neutral-text` |
| `--surface` | `--color-neutral-surface` |
| `--surface-foreground` | `--color-neutral-text` |
| `--surface-secondary` | `--color-neutral-surface-subtle` |
| `--surface-tertiary` | `--color-neutral-surface-muted` |
| `--overlay` | `--color-neutral-surface-raised` |
| `--overlay-foreground` | `--color-neutral-text` |
| `--muted` | `--color-neutral-text-muted` |
| `--border` | `--color-neutral-border` |
| `--separator` | `--color-neutral-border` |
| `--backdrop` | `--color-overlay-backdrop` |
| `--default` | `--color-neutral-surface-subtle` |
| `--default-foreground` | `--color-neutral-text` |

### Roles

| HeroUI variable | Soty source | Note |
|---|---|---|
| `--accent` | `--color-primary-solid` | honey: the one action a surface exists for |
| `--accent-foreground` | `--color-primary-on-solid` | |
| `--accent-hover` | `--color-primary-hover` | replaces HeroUI's `color-mix` guess with the product's own step |
| `--accent-soft` | `--color-primary-soft` | |
| `--accent-soft-foreground` | `--color-primary-text` | |
| `--accent-soft-hover` | `--color-primary-softer` | |
| `--success` / `-foreground` / `-soft` / `-soft-foreground` | `--color-success-solid` / `-on-solid` / `-soft` / `-text` | |
| `--warning` / … | `--color-warning-*` | |
| `--danger` / … | `--color-error-*` | HeroUI calls it danger; Soty calls it error. The bridge is the only place both names appear |
| `--focus` | `--color-focus-ring` | violet, as everywhere else |
| `--link` | `--color-secondary-text` | |

**Soty's `secondary` role has no HeroUI counterpart.** Violet is this product's identity colour
— navigation, selection, links, focus — and HeroUI has one accent. It is exposed to components as
a Tailwind utility (`text-secondary`, `bg-secondary-soft`) through half 2, and the inventory's
`color="secondary"` maps to it directly rather than through the library's accent.

### Fields

| HeroUI variable | Soty source |
|---|---|
| `--field-background` | `--color-neutral-surface` |
| `--field-foreground` | `--color-neutral-text` |
| `--field-placeholder` | `--color-neutral-text-muted` |
| `--field-border` | `--color-neutral-border` |
| `--field-radius` | `var(--radius-md)` |

HeroUI ships `--field-border-width: 0px` — borderless fields. Soty's fields have a border, so the
bridge sets `--field-border-width: 1px`. This is the one place the library's default look is
overruled rather than recoloured, and it is deliberate: a dense working tool needs field edges.

### Geometry and motion

| HeroUI variable | Soty source | Note |
|---|---|---|
| `--radius` | `--radius-md` | HeroUI derives the rest from it |
| `--border-width` | `1px` | matches the product |
| `--ring-offset-width` | `2px` | the product's one focus ring |
| `--disabled-opacity` | `0.5` | unchanged |
| `--spacing` | `4px` | Tailwind's spacing step equals Soty's `--space-1` |
| `--tooltip-delay` / `--tooltip-close-delay` | the product's existing delay-group values | |
| `--skeleton-animation` | `shimmer`, `none` under reduced motion | |
| `--surface-shadow` / `--overlay-shadow` / `--field-shadow` | `--shadow-md` / `--shadow-menu` / `--shadow-sm` | the product separates surfaces by tint, not elevation, so these are its own quieter shadows |

### What the bridge must not do

- It must not introduce a literal value. Every right-hand side is `var(--soty-token)` or a
  number that is already a Soty constant. `tokens.css` is the only file allowed to hold the
  literal, and it already does.
- It must not be duplicated per component. A component that needs a colour HeroUI does not model
  reads a Soty token directly through a utility, not through a new HeroUI variable.

---

## Half 2 — the Tailwind theme, in `tailwind.css`

```css
@layer theme, base, soty, components, utilities;

@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/utilities.css' layer(utilities);
@import '@heroui/styles';

@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *));

@theme inline {
  --color-primary: var(--color-primary-solid);
  --color-primary-soft: var(--color-primary-soft);
  --color-secondary: var(--color-secondary-solid);
  --color-secondary-soft: var(--color-secondary-soft);
  --color-success: var(--color-success-solid);
  --color-warning: var(--color-warning-solid);
  --color-error: var(--color-error-solid);
  --color-surface: var(--color-neutral-surface);
  --color-ink: var(--color-neutral-text);
  --color-ink-muted: var(--color-neutral-text-muted);
  --color-line: var(--color-neutral-border);

  --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius-lg);
  --radius-xl: var(--radius-xl);

  --text-display: var(--text-display);
  --text-title: var(--text-title);
  --text-section: var(--text-section);
  --text-body: var(--text-body);
  --text-label: var(--text-label);
  --text-caption: var(--text-caption);
  --text-micro: var(--text-micro);

  --ease-out: var(--ease-out-curve);
  --ease-in-out: var(--ease-in-out-curve);
  --duration-fast: var(--motion-fast);
  --duration-base: var(--motion-base);
  --duration-slow: var(--motion-slow);
}
```

Three things in that block are load-bearing:

1. **`@theme inline`, not `@theme`.** Without `inline`, a utility resolves the variable where the
   theme is declared, not where the class is used — so every colour would resolve to its light
   value inside a `[data-theme='dark']` subtree. This is documented Tailwind behaviour and it is
   the single most important line in the bridge.
2. **Tailwind's preflight is not imported.** The product has its own reset (`styles/base.css`),
   narrower and deliberate. Importing `theme.css` and `utilities.css` separately rather than the
   `tailwindcss` bundle is what leaves it out.
3. **Layer order `theme, base, soty, components, utilities`.** The existing sheets live in
   `soty`, so a legacy rule still beats a library base rule, and a utility still beats a legacy
   rule. That ordering is what makes each screen's migration a deletion rather than a rewrite.

### The scales that are deliberately absent

No `--color-blue-500`-style palette is exposed. The only colours a utility can name are the seven
Soty roles and the neutral ramp. `scripts/check-tailwind-classes.mjs` fails on anything else, so
`bg-blue-500` and `rounded-[10px]` are as impossible in TSX as `#3b82f6` already is in CSS.

---

## What the test asserts

`tests/theme-bridge.test.ts`:

1. Every variable HeroUI's stylesheet reads is defined by the bridge — the list is extracted from
   the installed `@heroui/styles` package, so a library upgrade that adds a variable fails the
   test rather than silently falling back to the library's own colour.
2. Every right-hand side in the bridge is a `var()` or a Soty constant — no literal.
3. The dark theme resolves: for each role, the light and dark values differ.
4. `@theme` is declared `inline`.
5. Tailwind's preflight is not imported.
