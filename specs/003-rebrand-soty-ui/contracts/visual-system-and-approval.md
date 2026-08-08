# Contract: Visual System and Approval

## Token use

- `design-tokens.json` is the normative color source.
- A deterministic generator emits preview-scoped `--soty-*` CSS and records source digest.
- Components use semantic/component roles; primitive material colors are limited to
  explicitly permitted honey artwork/detail roles.
- Typography, spacing, radius, elevation, motion and missing outcome colors are proposals
  until separately accepted; they must not be described as normative tokens.
- No purple-to-orange gradient, neon/glowing outline or pure-black dark canvas.

## Accessibility and responsive evidence

- Actual normal text pairs ≥4.5:1; large text and meaningful UI graphics/focus ≥3:1.
- Weak borders are not the sole control boundary; focus uses an opaque or dual visible ring.
- Status, error, progress, selection and disabled state never rely on color alone.
- Decorative bee/honeycomb/honey is hidden from assistive technology, unfocusable and
  non-interactive; it yields before content at constrained sizes.
- Keyboard order, accessible names, modal focus trap/restore/Escape, live status and
  disabled semantics are tested and manually reviewed.
- Reduced motion removes decorative loops and spatial transitions; indeterminate progress
  keeps explicit text.
- Automated viewport matrix: 320x568, 390x844, 768x1024, 1024x768 and 1440x900, light and
  dark, plus long strings. Manual real-browser 200% zoom is required.

## Approval record

Each row records iteration, surface, state, element (where relevant), theme, viewport/zoom,
reduced-motion mode, keyboard result, contrast result, screenshot/diff, notes, reviewer and
decision. Updating screenshots or passing automation is evidence only.

Production integration remains prohibited until the owner gives written approval for all
agreed key screens, both themes, responsive states, logo direction and every blocking item.
Approval starts a separate planning phase; it does not merge, deploy or activate Soty.

