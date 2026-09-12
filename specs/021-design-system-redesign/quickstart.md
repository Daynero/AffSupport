# Quickstart: Verifying the Design System

**Feature**: 021-design-system-redesign | **Date**: 2026-09-13

How to check that the system exists, that it holds, and that a migrated screen is actually
done. Nothing here needs the production stack — the beta environment and the test suite
cover all of it.

## Prerequisites

```bash
colima status || colima start            # the beta needs a container runtime
npm run beta:up                          # agent on :43140, web on :5175
```

The machine is small: run one heavy thing at a time (`uptime` before `tsc`/`vitest`).

## 1. The token layer holds

```bash
npx vitest run tests/design-tokens.test.ts
node scripts/check-design-tokens.mjs
```

Expected: every role has a value in both themes; every declared foreground/background pair
meets AA; no duration exceeds 300ms; the lint reports zero raw colour, duration, radius or
type values outside `styles/tokens.css`.

A failure names the file, the line and the value — for example
`apps/web/src/styles.css:8421 raw duration 600ms (use --motion-slow)`.

## 2. The inventory is complete and correct

```bash
npx vitest run tests/ui-components.test.tsx
```

Then, in the running beta, open <http://127.0.0.1:5175/design>:

- every component renders in every variant × size × colour it accepts;
- each one shows its rest, hover, active, focus, disabled and loading states side by side;
- toggle the theme control — nothing becomes unreadable;
- toggle reduced motion (macOS: System Settings → Accessibility → Display → Reduce motion) —
  nothing animates, and every state is still legible.

The page is development-only. Confirm it is absent from a production build:

```bash
npm run build:web && grep -r "DesignSystemPage" apps/web/dist/assets | head
```

Expected: no match.

## 3. A migrated screen is done

For each screen in the group, in the beta:

1. **States.** Force every state the screen's row in `contracts/screens.md` lists. Each one
   shows a title, one sentence of what is true, and the way out where one exists.
2. **Widths.** 1920 / 1440 / 1024 / 768 / 390. No overlap, no clipping, no horizontal scroll.
3. **Themes.** Dark and light, both readable.
4. **Motion.** No transition over 300ms; reduced motion removes them; nothing the reader does
   dozens of times an hour animates at all.
5. **Keyboard.** Reach every control by Tab in reading order; focus is always visible; a
   dialog traps focus and returns it to the trigger on close.
6. **Language.** Switch to Ukrainian — the longer strings still fit.
7. **Behaviour.** Unchanged. The screen's existing tests pass without being weakened.

```bash
npx vitest run tests/<the screen's tests>
```

## 4. Nothing regressed

```bash
uptime                                    # wait for load to settle first
npm run typecheck
npx vitest run
npm run lint
```

Expected: clean. Any test that asserted on a class name the redesign removed must have been
rewritten to assert the same behaviour through a role or an accessible name — never deleted,
never weakened (FR-038).

## 5. The stylesheet shrank

```bash
wc -l apps/web/src/styles.css apps/web/src/styles/*.css
```

Expected trend: total lines fall as groups land. The system replaces dialects; if the total
grows, a dialect survived.

## Done means

- `contracts/screens.md` has no unmigrated row;
- `node scripts/check-design-tokens.mjs` passes with zero exemptions;
- the full suite passes;
- the whole product has been walked at five widths × two themes × reduced motion;
- `docs/DESIGN-PRINCIPLES.md` points at the inventory and the token reference.
