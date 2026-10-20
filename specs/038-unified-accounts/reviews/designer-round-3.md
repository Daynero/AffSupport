# Independent designer review — round 3

Date: 2026-10-18. Frozen beta, own Chrome tab 766198381. Source reference supplied by root: 83-file working-tree hash `514fb817…`. UI actions via cua_repl only, with read-only DOM geometry. No product source edits.

**Score: 90/100.** Desktop workflow defects from earlier rounds stay resolved and primary table width is now bounded, but saving a narrow-layout draft remains insufficiently discoverable. The remaining issue is concrete rather than a threshold-related score adjustment.

## D6 remains open — narrow toolbar exceeds panel and puts Save offscreen

Reproduction at 390×844: edit DESIGN038 balance to `100`, Tab to yesterday expense. The field is visible and focus has a clear ring. The Accounts panel and table now fit: panel 358px, table 324px, page scrollX 0. This fixes the former 907px-wide parent.

However the sticky summary and search/filter toolbar still have minimum widths larger than their content area:

| Measured item | Width/value |
| --- | ---: |
| CSS viewport | 390px |
| document scrollWidth | 456px |
| `.unified-finance-summary` | 423.49px |
| summary scrollWidth | 1025px |
| `.team-accounts-toolbar` | 423.49px |
| Save left edge | 619.99px |
| Save right edge | 705.19px |

Save/Cancel follow long copy buttons in a horizontally scrollable summary, so the primary completion action is entirely outside the initial view without an obvious prompt to scroll. Filters also overflow the right edge. Apply shrinking constraints to sticky grid children as well as the panel; on compact layouts put Save/Cancel before optional copy actions or move the latter into the menu. Acceptance: document scrollWidth equals viewport, visible Save/Cancel whenever dirty, no page horizontal shift on keyboard focus.

## Independently verified

- 390px active financial field remains visible after Tab; the page no longer pans horizontally to 533px. Actual table scrolling stays internal.
- Compact period menu opens with Yesterday/This month/Previous month/Export and closes with Escape, restoring focus visibly.
- 768×1024 at 100% fits: document width 768px and panel width 736px.
- Exact native Chrome 200% zoom achieved using native UI; Chrome reports `Масштаб: 200%`. With 768 physical override, innerWidth becomes 384px and the same D6 overflow is present (document 456px). No additional zoom-specific issue identified. Restored 100% immediately.
- Earlier successful desktop caption, localized DnD, color-cycle, create and fresh-row-retention observations remain applicable; no contrary behavior observed this round.

## Evidence limits and coordination

- 500-RK fixture route opened but was still initially loading. Root requested ending UI to serialize browser-wide viewport ownership before a responsiveness judgement. No scale or frame-rate pass is claimed.
- Full pointer trajectory, exact500ms boundary and reduced-motion setting remain unverified independently. Earlier800ms hold proves pickup/click suppression only.
- Browser viewport overrides are browser-scoped and affect concurrent reviewer tabs. Future rounds must serialize ownership. Reset override and closed own tab before writing report.
- Root reports static13/13 passed; that is supplied context, not a substitute for visual verification.
