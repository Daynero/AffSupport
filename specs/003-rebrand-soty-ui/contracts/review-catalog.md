# Contract: Review Catalog

## Addressing

- Catalog: `/#/catalog?theme=light&locale=uk`
- Screen: `/#/screen/<surface-id>?state=<state-id>&theme=<light|dark>&locale=<uk|en-long>`
- Unknown/missing IDs return to catalog and show a demo-only explanatory notice.
- Every actionable element exposes stable `data-review-id`; feedback key is
  `iteration/surface/state/element`.

## Required surface groups

The catalog MUST include the 12 groups in [research.md](../research.md): auth entry, global
shell, home/tools, compressor, landing optimizer, landing gallery, transcription, team
lobby, team creation, team workspace, team settings and account. A component showcase is
additional evidence, not a replacement.

Each surface records every canonical state as either an executable scenario or an explicit
N/A with rationale. Completeness fails when a surface listed by production route/tool/team
inventory is absent or when a canonical state has neither decision.

## Interaction

- Card and CTA with one destination produce the same `navigate` action.
- A local action group has at most one honey primary action.
- Advanced settings use `toggle-disclosure` or a named nested screen and preserve safe
  demo selections on return.
- Confirmation always displays action, target and consequence.
- loading/active/success/error/disabled are textual states; decoration never substitutes.
- No action submits, authenticates, uploads, downloads, opens a native picker or leaves the
  review origin.

## Inventory reconciliation

Before each iteration, compare catalog with:

- `apps/web/src/Root.tsx`
- `apps/web/src/ProtectedSoty.tsx`
- `apps/web/src/lib/tool-registry.ts`
- `apps/web/src/team/**`

New in-scope production UI makes the review incomplete until catalogued. Marketing, legal,
admin-only and release/external surfaces remain explicit exclusions unless scope changes.
