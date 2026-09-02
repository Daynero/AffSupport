# The compressor, as a design specification

The compressor page (`apps/web/src/App.tsx`) is the reference every other Soty tool is
measured against. This document describes it exactly as it is built — every token, class,
size and state is read from `apps/web/src/styles.css` and the components in
`apps/web/src/components/`, not from intent. Where a rule exists because something else was
tried and failed, the reason is recorded, because that is the part a rebuild gets wrong.

`docs/DESIGN.md` states the house rules in the owner's words ("лакшері мінімалізм", icons over
words, words live in tooltips). This document is the anatomy underneath them.

---

## 1. The shell

```
<main class="workspace">          ← every tool page's root
  <section class="add-files-section">   ← sticky intake
  <section class="settings-panel">      ← collapsible settings
  <section class="batch-toolbar">       ← sticky action bar
  <section class="video-list">          ← the rows
```

| Rule            | Value                                                                         | Where        |
| --------------- | ----------------------------------------------------------------------------- | ------------ |
| Width           | `min(100%, var(--shell-width))`, centred                                      | `.workspace` |
| `--shell-width` | `max(1440px, 80vw)` — pixel cap on a laptop, tracks the viewport past ~1800px | tokens       |
| Grid gap        | `var(--space-3)` = 12px between sections                                      | `.workspace` |
| Padding         | `var(--space-4)` = 16px                                                       | `.workspace` |

Two things are sticky, and their order is deliberate:

- `.add-files-section` sticks at `top: var(--topbar-h, 62px)`, `z-index: var(--layer-header) + 1`.
  Intake is always reachable while scrolling a long queue.
- `.batch-toolbar` sticks at `top: calc(var(--topbar-h, 62px) + 108px)`, `z-index: var(--layer-header)`
  — **below** the intake zone, never over it.

An empty/checking state uses `<main class="workspace compact-state">`: `min-height: 240px`,
content centred, muted text.

---

## 2. Tokens

Every value below is a variable. A hard-coded colour or pixel size in a new tool is a bug.

### 2.1 Colour roles

| Role                     | Light          | Dark      | Meaning                                      |
| ------------------------ | -------------- | --------- | -------------------------------------------- |
| `--color-bg`             | `#f7f4fa`      | `#120f17` | Page canvas — never pure black               |
| `--color-surface`        | `#ffffff`      | `#1c1725` | Panels, rows, inputs                         |
| `--color-surface-subtle` | `#fbf9fd`      | `#171220` | Nested blocks                                |
| `--color-surface-muted`  | `#eeeaf1`      | `#241d2f` | Picto shelves, badges, tracks                |
| `--color-text`           | `#211a2c`      | `#f6f2f8` | Body                                         |
| `--color-text-muted`     | `#6c6173`      | `#b8adbe` | Secondary, summaries, hints                  |
| `--color-border`         | `#ded8e2`      | `#382f43` | Hairlines                                    |
| `--color-border-strong`  | `#c7becf`      | `#51435e` | Input outlines                               |
| `--color-accent`         | `--purple-600` | `#9b7aee` | Identity, selection, focus, links            |
| `--color-action`         | `--honey-500`  | `#ffb51b` | **The one primary CTA**, and active progress |
| `--color-on-action`      | `--honey-950`  | `#2d1a05` | Dark text on honey                           |

**The division is the whole colour system**: purple leads identity and selection; honey is
reserved for the single primary action and for progress that is really moving. A second honey
button on a screen is a design error.

Semantics stay non-purple: `--color-success #18794e / #56d597`, `--color-warning #9a6700 / #f2c14e`,
`--color-error #b42318`. Status rails and chips use their own literal hues (§7.3, §6.3).

### 2.2 Spacing, radius, type, motion

- Spacing: `--space-1..6` = 4, 8, 12, 16, 20, 24. Nothing else.
- Radius: `--radius-sm` 6, `--radius-md` 10, `--radius-lg` 14, `--radius-xl` 18.
- Type: a rem scale, `--text-2xs` 0.5625rem … `--text-9xl` 1.9625rem. **Pixels are not used for
  text** — the scale is rem so a reader's own setting still works.
  In practice on this page: `--text-sm` labels of last resort, `--text-lg` badges and counts,
  `--text-xl` field labels and summaries, `--text-3xl` the drop-zone headline.
- Motion: `--dur-micro` 130ms (colour/hover), `--dur-control` 180ms (control state),
  `--dur-section` 260ms, `--dur-complete` 450ms (the completion check draw).
  Easing: `--ease-standard cubic-bezier(0.2,0,0,1)` for almost everything.
- Shadows: `--shadow-sm/md/lg/xl` on a tinted-ink family (`rgba(36,27,58,α)`), never black.

---

## 3. Intake — the drop zone

`apps/web/src/components/DropZone.tsx`, `.drop-zone`.

**Anatomy**: one `<div role="button" tabIndex=0>` containing an icon span and a `<div>` with
`<strong>` (headline) over `<span>` (formats line). The whole zone is the click target; Enter
and Space activate it.

| Property     | Value                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------ |
| Height       | `min-height: 96px`, centred content, `gap: var(--space-3)`                                 |
| Border       | `2px dashed var(--honey-500)`                                                              |
| Background   | `color-mix(in oklab, var(--honey-800) 40%, var(--color-surface))`                          |
| Radius       | `--radius-lg`                                                                              |
| Icon         | lucide `Upload`, **44px**, `strokeWidth: ICON_STROKE` — the one place an icon exceeds 20px |
| Headline     | `<strong>`, `--text-3xl`                                                                   |
| Formats line | `<span>`, `--text-xl`, `--color-text-muted`                                                |

**States** — each is a class, and each changes border, background and _type_ colour together:

| State             | Class          | Treatment                                                                                              |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| Hover / drag over | `.is-dragging` | Border `--honey-400`, deeper field, type turns full honey, `inset 0 0 0 3px` ring while dragging       |
| Importing         | (prop)         | Icon becomes `<Spinner/>`, headline becomes the importing label                                        |
| Success flash     | `.is-ok`       | Green: border `#2f9e56`, type `#6fe08f`, field `color-mix(#06301a 62%, surface)`, icon becomes `Check` |
| Failure flash     | `.is-fail`     | Red: border `#b34343`, type `#ff9b9b`, field `color-mix(#360a0a 62%, surface)`, icon becomes `X`       |
| Disabled          | `.is-disabled` | `opacity: .54`, `cursor: not-allowed`, no hover                                                        |

The flash is a one-second confirmation, then it returns to rest. **The outcome is shown on the
zone itself**, not as a toast, because that is where the user is looking.

**Drops carry paths, not copies.** `droppedFilePaths(dataTransfer)` reads `text/uri-list` and
keeps only `file:` URLs; the caller receives absolute paths when the agent advertises
`local-file-paths`. Only when there are no paths does it fall back to `File` objects. This is
what makes "next to the original" mean the original.

---

## 4. The settings panel

`.settings-panel` — `apps/web/src/components/SettingsPanel.tsx`.

### 4.1 The slab

```css
display: grid;
grid-template-columns: auto minmax(0, 1fr);
gap: var(--space-3) var(--space-5);
padding: var(--space-4);
border: 1px solid color-mix(in oklab, var(--color-accent) 45%, transparent);
background: color-mix(in oklab, var(--purple-900) 55%, var(--color-surface));
```

Light theme replaces both: `border-color: accent 30%`, `background: color-mix(accent 8%, #fff)`.
**A panel that skips the light-theme correction stays dark violet on a pale page** — the single
most visible way to get this wrong.

`.settings-body` is `display: contents` so its children join the panel's own grid;
`[hidden]` is re-asserted as `display: none` because `contents` outranks it.

### 4.2 The header is the toggle

```
<button class="settings-collapse section-heading compact-heading">
  <SettingsIcon 20/1.75>  <h2>  <span class="settings-summary">…</span>  <ChevronDown class="settings-chevron">
```

- The whole strip is one `<button>`: transparent, no border, `color: var(--color-accent)`,
  `text-align: left`, full width.
- `h2` overrides back to `--color-text`; the gear and chevron stay accent.
- `.settings-summary` is `margin-left: auto`, `--text-xl`, `font-weight: 600`, with each
  key in `.settings-summary-key` (`--color-text-muted`, `font-weight: 400`, 6px right margin).
  It reports the **current choices** and stays visible when the panel is open, because that is
  when it is most useful.
- The chevron rotates `-90deg` when collapsed, `transition: transform var(--dur-control)`.
- Open/closed persists in `localStorage` (`wishly.compressor.settings-open.v1`).
- `aria-expanded` + `aria-controls` on the button; `aria-labelledby` on the section.

### 4.3 Field groups

```
<div class="field-group">
  <FieldLabel label tooltip? />     → .field-label: flex, gap 6px, --text-xl, weight 700
  <control/>
  <span class="optimal-summary">    → what is currently chosen, --text-xl, muted
```

`.field-group` is `display: grid; gap: 6px; align-content: start`. Inside the settings panel,
`.optimal-summary` is lifted to `color-mix(--color-text 70%)` — it reads as a value, not as
helper text.

Rows: `.settings-primary-row` is a **3-column grid** (`repeat(3, minmax(0,1fr))`,
`gap: var(--space-4) var(--space-6)`) on its own slab (`accent 30%` border,
`color-mix(--purple-950 55%, surface)` background; `#fff` in light). Between its groups sit
128px-tall fading hairlines drawn with `::before`.

### 4.4 Picto groups — the signature control

```
<div class="fit-mode-pictos" role="radiogroup" aria-label="…">
  <button type="button" role="radio" aria-checked class="is-selected?" data-tip="…" aria-label="…">
    <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />
```

| Property           | Value                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shelf              | `inline-flex`, `width: fit-content`, `gap: 6px`, `padding: 4px`, `1px solid var(--color-border)`, `--radius-md`, `background: var(--color-surface-muted)`     |
| Button             | **44 × 38**, `border-radius: calc(var(--radius-sm) - 2px)`, transparent border and background, `color: var(--color-text-muted)`                               |
| Selected           | `.is-selected` — `border-color: var(--color-accent)`, `background: color-mix(accent 16%, surface)`, `color: var(--color-accent)`                              |
| Hover (unselected) | `color: var(--color-text)` only                                                                                                                               |
| With a value       | `.is-labeled` — width auto, `padding: 0 10px`, icon + digits, `--text-md`, tabular numerals                                                                   |
| A lone toggle      | shelf gets `.is-single` — shelf border and background disappear; the button keeps its own border. Two outlines around one control is the error this prevents. |

Rules that are not optional:

- `width: fit-content` on the shelf — no empty rail trailing after the buttons.
- The class is **`is-selected`**. `is-active` means something else in this codebase (§5.2).
- Every button carries `data-tip` **and** `aria-label`: the label lives in the tooltip, never
  under the icon.
- Icons are lucide at `ICON_SIZE = 20`, `ICON_STROKE = 1.75`. If it feels tight, the plate
  grows; the icon never shrinks.

### 4.5 Inline inputs

`.start-duration-row` puts a picto group and its custom value on one line
(`display: flex; align-items: center; gap: 10px; flex-wrap: wrap`).

| Input                       | Class                                     | Width                                  | Height |
| --------------------------- | ----------------------------------------- | -------------------------------------- | ------ |
| Milliseconds / minutes      | `.time-input` in `.custom-duration-input` | 72px (64px in `.final-duration-field`) | 34px   |
| Custom value in a picto row | `.input-with-suffix input`                | 96px                                   | 34px   |
| Name suffix                 | `.suffix-input`                           | 150px                                  | —      |
| Bare `.time-input`          |                                           | `min(180px, 100%)`                     | 36px   |

`1px solid var(--color-border-strong)`, `--radius-sm`, `font-variant-numeric: tabular-nums`.
Number spinners are removed globally — values are typed. A unit ("мс", "px", "fps") is a
muted `<span>` **outside** the input box, never placeholder text inside it.

### 4.6 The destination row (`OutputSettings`)

The pattern every "where does it go" control follows:

```
.field-group
  FieldLabel("Куди зберегти", tooltip)
  .output-control-row (flex, nowrap)
     .fit-mode-pictos  → Files (next to originals) | FolderOpen (chosen folder)
     input.time-input.suffix-input   placeholder "_compressed"
  .optimal-summary.output-mode-summary   → the chosen mode, in words
  .selected-folder                        → the path, one line lower, compactPath()
```

The chosen mode sits **under** its icons like every other picto group, and the folder path one
line lower still, `display: block; margin-top: 4px`, so it can never push the suffix field onto
a second row.

---

## 5. The image galleries

### 5.1 Columns

`.image-columns` — `grid-template-columns: repeat(2, minmax(0,1fr)); gap: var(--space-3)`, with
a fading hairline above it (`::after`, transparent → `--color-text 20%` → transparent).

Each `.image-column` inside a settings panel is its own slab:
`padding: var(--space-3)` (bottom 8px), `1px solid color-mix(accent 26%)`,
`background: color-mix(accent 6%, surface)` — and `#fff` with `accent 20%` in light theme.
`grid-template-rows: auto auto minmax(0,1fr)` so both galleries end on the same line.

Heading: `.image-column-heading` — flex, gap 6px, containing the slot switch, `<h3>`, and a
`Tooltip` carrying the explanation.

### 5.2 Tiles

`.image-grid` is a grid of **squares**: `repeat(auto-fill, 124px)` columns, `grid-auto-rows: 124px`,
`gap: 6px`. `.image-grid-scroll` caps at exactly two rows and only becomes scrollable when the
tiles really exceed them (`.is-scrollable`), because an unscrollable overflow box still eats
wheel events.

`.selected-image-tile`: `overflow: hidden`, `1px solid var(--color-border)`, `--radius-md`,
`background: var(--purple-900)`, `animation: fade-rise` on mount. Its `img` is
`object-fit: cover`. Its `> span` is the dimension caption — bottom-right, `2px 5px`,
`rgba(24,17,38,.66)`, `backdrop-filter: blur(4px)`, radius 5px, tabular numerals. The delete
button is a 30 × 30 plate at top-right (`rgba(255,255,255,.82)`, blur 5) holding a 20px icon —
the comfort rule in miniature.

**`is-active` / `is-inactive` mean "in or out of the random pick", not "selected".**

| Class          | Treatment                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.is-active`   | `outline: 1px solid color-mix(#34c759 55%)` plus a two-step green glow (`0 0 10px 1px 45%`, `0 0 26px 8px 16%`)                                                                                                         |
| `.is-inactive` | `outline: 1px solid color-mix(#ff6b6b 75%)` inset; image `grayscale(1) blur(2px) opacity .75`; a 20% grey veil `::after` over the whole tile; and a **centred caption drawn from `data-inactive-label`** via `::before` |

A tool that reuses these classes for a different meaning must supply `data-inactive-label`, or
the caption renders empty — and should ask first whether "excluded from a random pick" is
really what it means.

---

## 6. The action bar

`.batch-toolbar` — sticky, `padding: 9px 10px`, `box-shadow: 0 5px 18px var(--tint-soft)`,
panel border and radius (§7.1). One `.batch-toolbar-row` inside: `flex; nowrap; gap: var(--space-4)`.

Order, left to right:

1. `.selection-actions` — select-all `Checkbox` (20px square, honey outline and check) plus a
   ghost "clear selection" button. `flex: 0 0 auto`.
2. `.batch-chips` — `margin-right: auto`, `padding-left: var(--space-5)`, preceded by a 34px
   hairline divider that fades at both ends (`::before`, `--color-text 26%` at its middle).
3. `.primary-actions` — `flex: 0 0 auto; nowrap`.

### 6.3 Chips

`.batch-chip` is **not a pill**: `padding: 0; border: none; background: transparent`,
`--text-xl`, `weight 600`, `white-space: nowrap`. Markup is `<b>{count}</b>` then
`<span class="chip-word">` — the number is bold, the word is not.

| Variant          | Dark                 | Light     |
| ---------------- | -------------------- | --------- |
| default          | `--color-text-muted` | —         |
| `.is-processing` | `#ff8c1a`            | `#b25a00` |
| `.is-done`       | `#4ade6a`            | `#1f7a3d` |
| `.is-failed`     | `#ff4d4d`            | `#c53030` |

All four counters stay on screen even at zero — a zero is information.

### 6.4 Buttons

`.button`: `min-height: 44.2px`, `padding: 0 15.6px`, `gap: var(--space-2)`,
`border-radius: var(--radius-sm)`, `font-weight: 650`, `line-height: 1`, `white-space: nowrap`.
`:active` scales to `.98`; `:disabled` is `opacity: .46`.

| Variant            | Treatment                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `button-primary`   | Honey gradient `180deg action → action-hover`, dark `--color-on-action` text, `inset 0 1px 0 rgb(255 255 255/40%)` sheen. Hover lifts 1px and adds `--shadow-raise`. **One per screen.** |
| `button-secondary` | `--color-surface` on `--color-border-strong`, text `--color-text`                                                                                                                        |
| `button-ghost`     | Transparent, `--color-text-muted`                                                                                                                                                        |
| `button-danger`    | `--color-error` on `--color-error-soft`                                                                                                                                                  |
| `button-success`   | `--color-success` on `--color-success-soft`                                                                                                                                              |
| `.is-loading`      | Label turns transparent, a centred spinner overlays it and a sheen sweeps — the width never changes                                                                                      |

Content pattern in the toolbar: `<Icon size={18} strokeWidth={1.75}/>` then
`<span class="action-label">`. Icons in buttons are **18px**, not the canonical 20 — the button
already provides the plate.

---

## 7. The rows

### 7.1 The panel family

`.settings-panel, .batch-toolbar, .batch-progress, .job-row, .result-summary, .onboarding-panel,
.blocking-message` all share `1px solid var(--color-border)`, `--radius-lg`,
`background: var(--color-surface)`. Anything that is a surface on this page starts here.

### 7.2 Grid

```css
.job-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 228px; /* before | after | actions */
  gap: var(--space-4);
  padding: var(--space-3);
  overflow: hidden;
  background-clip: padding-box;
  content-visibility: auto;
  contain-intrinsic-size: auto 132px;
}
```

The action column keeps its 228px even while a job runs, so the two information columns never
resize mid-run. `content-visibility` skips paint for off-screen rows while keeping the DOM whole
(find-in-page, screen readers and keyboard navigation all still work) — windowing was rejected
because these rows expand and their heights are not known ahead of time.

### 7.3 The status rail

This is the row's signature, and it is drawn without an extra element:

- The row's own `background-color` is the **rail colour**.
- `::before` lays the card body over it at `inset: -1px -1px -1px 8px`, radius `--radius-lg`,
  `background: inherit` — leaving exactly 8px of colour down the left edge, rounded at all four
  corners rather than squared off.
- Every child gets `position: relative; z-index: 1` so it sits above the body.

| `data-state`                                     | Rail      | Body wash                         |
| ------------------------------------------------ | --------- | --------------------------------- |
| `processing`, `queued`                           | `#3b82f6` | `color-mix(#3b82f6 15%, surface)` |
| `completed`                                      | `#22c55e` | `color-mix(#22c55e 14%, surface)` |
| `failed`                                         | `#ef4444` | `color-mix(#ef4444 8%, surface)`  |
| `cancelled`, `interrupted`, `ready`, `analyzing` | `#9aa0aa` | grey wash                         |

`.is-processing` additionally gets an accent border and a 3px accent halo.
`.is-fresh` glows honey for three seconds after a file is added, then settles.

### 7.4 Row contents

```
.job-main
  .job-header      grid: auto | minmax(0,1fr) | auto
    Checkbox
    .job-title-block  (grid, gap 3px)
      .job-title-line   → <h3 data-tip={name}> (ellipsised) + <StatusBadge>
      <JobTimer>
  <OriginalPanel>
.job-side          grid: minmax(0,1fr) | auto
  progress panel or outcome panel
  .job-actions     stacked buttons, width max-content, min-width 228px
```

The whole card toggles its checkbox on click — except where a real control lives
(`button, a, input, label, [role="button"], details, summary` are excluded by a `closest()`
check). Selection is applied on `change`, not `click`, so Shift+Space extends a range from the
keyboard as well as the mouse.

### 7.5 Status badges

`.status-badge`: `inline-flex`, `min-height: 23px`, `gap: 6px`, `padding: 0 8px`,
`border-radius: 999px`, `--text-lg`, `weight 700`, colour transitions at `--dur-control`.

| Status class                                                | Colour / background                             |
| ----------------------------------------------------------- | ----------------------------------------------- |
| `.status-analyzing`, `.status-queued`, `.status-processing` | `--color-accent-hover` on `--color-accent-soft` |
| `.status-completed`                                         | `--color-success` on `--color-success-soft`     |
| `.status-failed`, `.status-interrupted`                     | error pair                                      |
| default                                                     | `--color-text-muted` on `--color-surface-muted` |

The badge's leading glyph is part of the state: a `SotyLoader` while processing, an animated
check (`stroke-dasharray` drawn over `--dur-complete`) on completion, and a plain `<i>` dot
otherwise.

---

## 8. Blocking messages

`.blocking-message` uses the panel base plus a tone: `blocking-neutral | blocking-warning |
blocking-error`. Markup is a `<section role="alert">` holding `<div><strong>title</strong>
<span>body</span></div>` and an optional action node on the right. This — not a toast — is how
the page says "the local app is not connected" or "the media engine is missing".

---

## 9. Iconography

- Source: **lucide-react** only. No hand-drawn SVG.
- Sizes: `ICON_SIZE = 20` / `ICON_STROKE = 1.75` (`components/icons.tsx`) everywhere;
  **18px inside buttons**; **44px** for the drop-zone glyph; 30px plates for tile actions.
- Meanings already assigned, and to be reused rather than re-chosen:
  `Sparkles` optimal · `SlidersHorizontal` custom · `Gauge` bitrate · `Gem` quality ·
  `Monitor` resolution · `Film` frame rate · `Timer` duration · `Dices` random ·
  `Crop` fill · `Minimize2` fit · `UnfoldVertical` stretch · `Files` next to originals ·
  `FolderOpen` choose folder · `Settings` panel header · `ChevronDown` collapse ·
  `Upload` intake · `Check`/`X` outcome · `Play`/`Pause`/`Ban`/`Trash2` run control ·
  `Plus`/`X` add/remove.

---

## 10. Interaction rules

- **Words live in tooltips.** A control shows an icon; its name is `data-tip` + `aria-label`.
  Explanatory sentences go in the `Tooltip` beside a `FieldLabel`, never as standing text.
- **Validation appears only after invalid input.** An empty field just opened is not an error
  (`&& custom !== ''`). Invalid state is `.is-invalid` on the field plus `.field-error` under
  the row, revealed through `Collapse fast`.
- **Nothing is destructive without a verified success first** — the compressor keeps the
  original when the encode came out larger, and says why.
- **Every state is a class, and every class changes several properties at once** (border,
  background and text together). A state signalled by colour alone does not read.
- `@media (prefers-reduced-motion: reduce)` is honoured globally; nothing depends on animation
  to be understood.

---

## 11. Theming

Two themes, one set of variables. Rules:

1. Never hard-code a colour that has a token.
2. `color-mix(… , var(--color-surface))` adapts on its own; `color-mix(…, var(--purple-900))`
   does **not** — `--purple-900` is a fixed brand primitive, so any surface built from it needs
   an explicit light-theme correction under
   `:root[data-theme='light'] …, :root:not([data-theme='dark']) …`.
3. Both selectors are always written together: `[data-theme='light']` for an explicit choice and
   `:not([data-theme='dark'])` for the system default.
4. Literal state hues (rails, chips, glows) get their own light-theme values — the dark-theme
   greens and reds are too bright on white.

---

## 12. Checklist for a new tool

A page is "in the compressor's language" when all of this is true:

- [ ] `<main class="workspace">`; sections in the shell order; sticky intake above sticky toolbar.
- [ ] Intake is the real `DropZone` component, with `addDroppedFilePaths` wired when the agent
      advertises `local-file-paths`.
- [ ] Settings live in a `.settings-panel` whose header is one button: gear, `<h2>`,
      `.settings-summary` of the current choices, rotating chevron; open state persisted.
- [ ] Every choice is a `.fit-mode-pictos` radiogroup with `.is-selected`, `data-tip` and
      `aria-label`, 44 × 38 buttons, 20px lucide icons, `.optimal-summary` underneath.
- [ ] Custom values are inline `.time-input`s of 64–150px on the same row, units outside the box.
- [ ] Galleries use `.image-columns` / `.image-column` / `.image-grid` / `.selected-image-tile`
      with 124px squares — and only use `.is-active` / `.is-inactive` if the meaning really is
      "in or out of a random pick".
- [ ] The action bar is `.batch-toolbar` → `.batch-toolbar-row` with chips left (`<b>` + word)
      and `.primary-actions` right; exactly one `button-primary`; icons at 18px with
      `.action-label`.
- [ ] Rows are `.job-row` with `data-state`, the 8px status rail, `.job-main` / `.job-side`,
      `.job-title-line` with an ellipsised `<h3 data-tip>` and a `.status-badge`.
- [ ] Every new surface built on `--purple-900` has a light-theme correction, and the page has
      been looked at in both themes.
- [ ] No new colour, spacing or radius that is not a token.
