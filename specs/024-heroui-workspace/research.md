# Research — 024 the team workspace on HeroUI

Every decision below was taken against the working tree at `66bcc1f` (branch `beta-dev`) and the
five-part audit of the workspace recorded in `spec.md`. Nothing here is a preference; each entry
says what was chosen, why, and what was rejected.

---

## D1. The library: HeroUI v3

**Decision.** `@heroui/react@3.2.5` + `@heroui/styles@3.2.5`, MIT, with its React Aria peers
installed explicitly and pinned: `react-aria@3.52.1`, `react-aria-components@1.21.1`,
`@react-aria/i18n@3.13.1`, `@react-aria/ssr@3.10.1`, `@react-aria/utils@3.34.1`, and
`@internationalized/date@3.12.4` for the calendar's date type. Tailwind CSS `4.3.1` through
`@tailwindcss/vite@4.3.1`. `tailwind-variants` and `tailwind-merge` arrive as HeroUI's own
dependencies and are not declared by us.

**Rationale.**

- It is what the owner chose after seeing shadcn/ui, Mantine and React Aria Components.
- The stack matches exactly: HeroUI v3's own Vite template is React 19 + Vite 8 + Tailwind 4,
  which is this repository's stack down to the major versions.
- v3 needs **no provider**, so there is no new global wrapper to thread through `Root.tsx`.
- It is built on React Aria, so keyboard behaviour, focus management and ARIA come from Adobe's
  implementation rather than from ours. The audit found five hand-rolled roving-focus
  implementations in the workspace; all of them are deleted by this choice.
- Its catalogue (≈80 components) covers everything the workspace needs **except** a tree and a
  timeline, both of which stay ours.
- Its theme is plain CSS custom properties on `:root` with `[data-theme="…"]` selectors already
  supported — which is precisely the mechanism this product already uses.

**Alternatives rejected.** Mantine: the owner found it visually dull, and its styling engine
would have replaced the token layer rather than consumed it. shadcn/ui: a good fit technically,
but the owner chose HeroUI. React Aria Components alone: gives behaviour and no appearance,
which is the half we are least short of. Staying bespoke: the audit's numbers are the argument
against.

**Risks accepted.** HeroUI v3 is young; a missing variant is resolved by composition
(`Calendar.*` and friends are compound components) rather than by forking. The React Aria tree
is large on disk but tree-shakes; D7 handles the weight question with measurement rather than
hope.

---

## D2. How Soty's tokens drive HeroUI, and not the other way round

**Decision.** `apps/web/src/styles/tokens.css` stays the only file in the product permitted to
spell a value, and it gains one new block: HeroUI's theme variables **defined from Soty roles**.

```
--accent: var(--color-primary-solid);
--surface: var(--color-surface);
--radius: var(--radius-md);
--danger: var(--color-error-solid);
…
```

The dark theme needs no second copy of this block: the Soty roles it reads are themselves
redefined under `:root[data-theme='dark']`, so the bridge inherits the flip for free.

For Tailwind's own utilities a second, smaller bridge is declared with **`@theme inline`**:

```
@theme inline {
  --color-primary: var(--color-primary-solid);
  --radius-md: var(--radius-md);
  --text-body: var(--text-body);
  …
}
```

`inline` is load-bearing: without it Tailwind resolves the variable where the theme is declared
rather than where the utility is used, so a token redefined under `[data-theme=dark]` — which is
how every Soty colour works — would resolve to its light value inside a dark subtree. This is
documented behaviour, not a workaround.

**Rationale.** It keeps the existing design gate meaningful (`tokens.css` is the only file the
raw-value checker exempts) and means the library is themed once, centrally, rather than screen by
screen. `bg-primary` and `--accent` then mean the same colour by construction.

**Rejected.** Letting HeroUI's default theme stand and overriding per component: that is how a
product ends up with two palettes. Declaring Tailwind's theme with literal values: that would put
a second source of colour in the tree and break the gate's premise.

---

## D3. Dark mode stays on `data-theme`

**Decision.** Keep `data-theme` on `<html>`, keep the pre-paint commit in `index.html`, keep the
775 ms `.is-theming` cross-fade. Teach Tailwind about it in one line:

```
@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *));
```

HeroUI's own selectors already include `[data-theme="dark"]`, so nothing else is needed.

**Rejected.** Adding a `dark` class alongside the attribute: two sources of truth for one fact,
and the pre-paint script would have to write both.

---

## D4. Coexistence: Tailwind's reset must not touch un-migrated screens

**Decision.** Import Tailwind **without preflight** and order the cascade layers explicitly:

```
@layer theme, base, soty, components, utilities;
```

`soty` holds the existing sheets. Tailwind's `base` sits below it, so a rule in `styles.css`
still wins over a reset, and a utility class in `utilities` still wins over `styles.css` — which
is the order a migration needs: old screens unchanged, new classes authoritative.

Preflight is omitted rather than included-and-fought because the product already has its own
reset (`styles/base.css`, 183 lines) which is narrower and deliberate.

**Rationale.** The audit's finding S7 from the previous migration is the warning here: renaming a
control renames the selectors that lay it out. Layer order is what makes a screen's migration a
deletion rather than a rewrite.

**Rejected.** Full preflight: it would reset `styles.css`'s assumptions on 1,201 classes at once,
turning a phased migration into a flag day.

---

## D5. The inventory keeps its API; its insides become HeroUI

**Decision.** `apps/web/src/components/ui/*` keeps every export name, every prop name, and the
`color` × `variant` × `size` vocabulary. Each component's body becomes a thin adapter over its
HeroUI counterpart. Each adapter continues to emit the semantic marker classes
(`ui-button ui-button--solid ui-color-primary is-loading`) **in addition to** the library's
classes.

**Rationale.** Three things fall out of this at once:

1. The 128 modules that import the inventory do not change, so the migration is behavioural and
   reviewable screen by screen rather than a 128-file rename.
2. The screens outside the team workspace (compressor, transcription, stitcher, auth, landing
   viewer) inherit the new controls with no work and can be checked for regression rather than
   rewritten.
3. `tests/ui-consistency.test.tsx` keeps working **unchanged**. Its `signature()` filters
   classes to the `ui-`/`is-` prefixes; because the adapters keep emitting them, "one role, one
   appearance" stays mechanically checkable. Without the markers those assertions would pass
   vacuously, which is worse than failing.

The legacy shim `apps/web/src/components/ui.tsx` — which shadows eight pre-redesign names by
file-beats-directory resolution — is **deleted** in this feature, and its 70 importers moved to
the inventory. It exists to make 021 landable without a flag day; keeping it through a second
migration would mean three generations of `Button` in one tree.

**Rejected.** A parallel `components/heroui/` namespace used only by team screens: it keeps the
library out of the shared chunk but guarantees two design systems, which is the disease this
feature treats. Rewriting call sites to HeroUI directly: it makes every future library decision a
128-file change.

---

## D6. The gates: one survives intact, one is added, three are adjusted

**Decision.**

| Gate | What happens |
|---|---|
| `scripts/check-design-tokens.mjs` | **Unchanged.** It walks `.css` files under `apps/web/src`. Tailwind's output is generated by the Vite plugin at build time and never written into the source tree; our own new stylesheet contains `@import`, `@theme inline`, `@custom-variant` and `var()` references only. The exemption list stays empty. |
| `scripts/check-tailwind-classes.mjs` | **New.** Fails on a utility written in application code that carries a literal value — an arbitrary value in brackets (`bg-[#fff]`, `rounded-[10px]`, `duration-[250ms]`), or a palette step that is not a Soty role (`bg-blue-500`, `text-gray-400`). This is the same fence as the CSS checker, moved to where values can now be written. |
| `scripts/verify-styles.mjs` | **Unchanged in rule, extended in input.** It concatenates the authored sheets; the new one declares nothing and references only tokens. |
| `tests/stylesheet-integrity.test.ts` | **Unchanged.** Its `@property` and `@keyframes` assertions read authored sheets, not generated CSS. |
| `tests/ui-consistency.test.tsx` | **Unchanged**, by construction — see D5. |
| `tests/design-components.test.tsx` | **Rewritten.** It pins literal class markers of the *legacy* shim, which D5 deletes. Its assertions move onto the inventory's own markers. |
| `tests/performance-budgets.test.ts` | **Unchanged in rule**; its baseline is re-measured once, at the end, with the difference explained (D7). |
| `a11y-baseline.json` | **Unchanged** — zero tolerance stays zero. React Aria should move this in the right direction. |
| `scripts/generate-csp-headers.mjs` | **Unchanged.** `style-src` already allows `'unsafe-inline'`, which is what React Aria's positioning needs. |

**Rationale.** The audit predicted a total collapse of the token gate. It was right about the
danger and wrong about the mechanism: the danger is real, but it arrives through TSX, not
through CSS, because Tailwind v4 with the Vite plugin never lands a stylesheet in `src`. Moving
the fence to where the values can be written keeps the discipline at full strength with one new
script instead of an exemption list.

---

## D7. Weight: measure, then decide, then state

**Decision.** Measure the gzipped bundle before the first HeroUI import and after the last screen
is migrated, and re-ratchet `performance-baseline.json` once, with the note naming both halves:
the library added and the CSS deleted. `vite.config.ts`'s `manualChunks` gains a `heroui` group
beside the existing `react` and `supabase` groups, so the library does not attach itself to
whichever chunk imported it first — the mistake the current config's own comment records.

**Rationale.** The previous design system's growth (+9.4 kB on the preloaded chunk) was accepted
because it was the feature working. The same argument applies here only if the number is known
and stated. The offsetting side is real: team-owned CSS alone is 3,529 dedicated lines plus large
sections of a 16,951-line global sheet, and SC-009 requires at least 60 % of it to go.

**Rejected.** Setting a budget in advance and designing to it: it would pick the number before
knowing the trade, which is how the existing baseline's comment says budgets get ignored.

---

## D8. The constitution must be amended first

**Decision.** Principle VI is amended from "one global stylesheet … style with `className`
strings against `styles.css`" to a statement of the same discipline under the new mechanism:

- the token layer remains the only source of values;
- the component inventory remains the only source of controls;
- new style is written as utilities against the token-derived theme, and a screen-level
  stylesheet is what a screen keeps only until its migration deletes it;
- theming remains CSS custom properties + `data-theme`.

This is a **MAJOR** amendment (2.0.0 → 3.0.0) because it redefines a principle. It carries a Sync
Impact Report, and the owner is the maintainer who approves it. `CLAUDE.md`, `AGENTS.md` and
`docs/DESIGN.md` are updated in the same change, because all three restate the old rule.

**Rationale.** Governance says the document wins for new work. Writing the code first and the
rule afterwards would make every file in this feature a documented violation.

---

## D9. One definition of what can be done to a material

**Decision.** A single registry describes every material action once:

```
id, group, label key, icon, destructive?,
applies(material) → boolean          // never true for this kind of object
available(material, context) → ok | { reason }
run(material, context) → Promise
```

Groups are fixed and ordered: **open · get · make · organise · remove**. One hook resolves the
registry against a material and a context and returns a ready list; one menu component renders
it; one inline-actions component renders the first N of it.

Context carries: the space, the caller's permissions, the current folder (if any), whether the
local agent is connected, whether storage is connected, and a `host` describing the surface so an
action can decline to be offered where it makes no sense.

Every existing surface — folder row, grid tile, search result, detail surface, task attachment,
updater row, selection bar — renders from this one source. The audit found the plumbing already
permits it: `useMaterialActions` is deliberately decoupled, `ProductCatalogMenuDialog` needs only
`teamId` and `{id, name}`, `MaterialProcessFlow` takes an `initialTool`, and only
`explorer/RowActions.tsx` is genuinely explorer-bound.

**The one genuinely coupled action is compression**, whose queue lives inside
`ExplorerShell.tsx`'s 2,231 lines. It is lifted into a provider at the space level — the same
move `LibraryProcessingProvider` already made for batches — so a task can enqueue a compression
without the explorer being mounted.

**Rationale.** It is the only way SC-003 ("identical across all five surfaces") can be verified
by a test rather than by eye, and it is what makes US1 a small change instead of a large one.

**Rejected.** Passing a longer list of `on*` callbacks down to each surface: that is the current
design, and it is why the task attachment has six actions and the folder row eleven.

---

## D10. Tasks: one save model, and it is autosave

**Decision.** Every field in the task editor writes as it changes, through the existing
coalescing writer, with a quiet saved indicator and a loud, retryable failure. The Save button,
the unsaved-changes prompt, the sessionStorage draft, the staged-attachment concept and the
"will be added on save" wording are all deleted. The picker attaches on confirm. Detach keeps its
Undo toast.

**Rationale.** The audit found two save models in one dialog with nothing marking the line, and
the owner's own example broke on exactly that seam (reveal-in-explorer bypasses the prompt and
loses staged attachments). Choosing autosave rather than staging is forced by the rest of the
product: status, progress, agent tags and dropped uploads already write immediately, and the
optimistic-concurrency work of the previous feature already makes a per-field write safe.

**Risk.** A field that loses a concurrency race must say so rather than snap back — the failure
that was fixed for progress in `faebfb8` and must not be reintroduced field by field. The write
path therefore keeps the version check for form fields and surfaces a conflict as an explicit
"take the newer value" choice.

---

## D11. Dates

**Decision.** `Calendar` / `RangeCalendar` / `DatePicker` from HeroUI, with `CalendarDate` from
`@internationalized/date` as the wire type inside the UI layer only; the API keeps its existing
string shape and one adapter converts at the edge. The board's quick ranges become the
calendar's presets, beside it. The half-made-range behaviour is decided once — the range is kept,
not abandoned, and the popover says what will happen — closing finding B4 of the previous feature.

**Rationale.** Two hand-written 42-cell calendars with different behaviours is the largest single
lump of bespoke UI in tasks, and the owner named the calendar as the thing he liked.

---

## D12. Discoverability: palette, context menu, shortcut sheet

**Decision.**

- **Command palette** on ⌘K / Ctrl+K, built from HeroUI's autocomplete + listbox, searching
  spaces, folders, materials, tasks and accounts through the existing search endpoints, and
  offering the highlighted result's actions from the D9 registry. It is a workspace-level
  surface, addressable like settings and the updater.
- **Context menu** on explorer rows and tiles, rendering the same D9 menu at the pointer, acting
  on the checked set when the pointer is over a checked row.
- **Shortcut sheet** listing every binding the product makes, reachable from the palette and
  from the header, and each shortcut named in the tooltip of the control it duplicates.

**Rationale.** These are the "hide it well" half of the request: the way to reduce what is on
screen without losing what the product can do.

---

## D13. What is deleted rather than migrated

The audit found controls that are unreachable or lying. Each is resolved, not carried forward:

- **"Edit text" in the folder view** — the explorer never passes the handler, so the item is dead
  in every folder. It is wired up (the transcript editor exists and works from search).
- **The legacy UI shim** and its eight shadowed names (D5).
- **The hand-rolled agent menu** and its module-level "one menu open" global (D9's menu replaces
  it).
- **The second, always-rendered compact breadcrumb** that CSS chooses between.
- **The duplicated Members screen** — one of the two doors goes.
- **`aria-controls` on the money fold**, which names a list that is never hidden.
- **The duplicated sort**, applied once in the shell and again in each view.
- **The unused inventory components** (`Separator`, `InputNumber`, `InputTags`, `Textarea`,
  `Switch`, `Skeleton`, `Drawer`, `Link`, `Pagination`, `Accordion`, `Timeline`, `User`,
  `ConfirmDialog`, `SelectionBar`) are not deleted — they are **used**, because the audit found a
  hand-rolled equivalent of almost every one of them in the workspace.

---

## D14. Testing strategy

- **Unit, jsdom**: the action registry resolves identically for one material across all five
  host surfaces (SC-003); every menu with more than five items is grouped (SC-004); the task
  editor writes without a Save button and has no prompt (SC-005).
- **Contract**: the theme bridge defines every HeroUI variable the library reads, in both themes;
  no inventory component emits a class outside its marker grammar.
- **Static**: raw `<button>/<input>/<select>/<textarea>` count in `apps/web/src/team/` is zero
  (SC-002); no Tailwind utility carries a literal value (D6).
- **Visual, by hand on the beta**: every team screen at 390 px and 1440 px in both themes, walked
  and photographed, because that is the only way SC-011 and the "gorgeous" half are judged.
- Vitest runs single-fork on this machine; `npm run verify` is never run here — the gates are run
  individually and the aggregate is left to CI.

---

## D15. Sequencing

The feature is landable in six checkpoints, each leaving the app working and each independently
verifiable on the beta:

1. **Foundation** — deps, Tailwind, theme bridge, layers, gates, constitution, `/design` shows
   both generations side by side.
2. **Inventory** — every component's insides become HeroUI, markers preserved, legacy shim
   deleted, every screen in the product inherits the new look at once.
3. **Material actions** — the registry, the shared menu, the detail surface, the compression
   provider; the owner's example works.
4. **Tasks** — autosave, layout, attachments first-class, calendar.
5. **Explorer and search** — one identity for a material, grouped menus, context menu, palette,
   shortcut sheet, scope unification.
6. **Accounts, members, settings, chrome** — the last bespoke screens, the chrome fixes, and the
   deletion of every stylesheet rule the migration orphaned.
