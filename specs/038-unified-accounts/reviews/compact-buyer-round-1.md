# Compact Accounts — independent buyer review, round 1

Source freeze: `36e0637ef0f9d11739a32c5c47e808b11b4f12bcc251aba8db41e1e2cafd2683`.
Review date: 2026-10-18. Real local Beta, Chrome viewport 1384 × 666, Ukrainian, existing dark theme. Fresh reviewer-owned tab `766198450`; no existing account or finance data modified. Reviewer did not author implementation or tests.

**Score: 8.8 / 10. Changes required before 9.9 acceptance.**

## Blocking finding

Switching Today → Yesterday preserves row geometry at the top, but fails at a lower working position when dated social membership differs. Reproduction through actual UI: scroll the Accounts table to its bottom on Today, then click Yesterday while the toolbar remains visible. Today table scrollTop was **371**; Yesterday removed the two socials created today, reducing content height, and the browser clamped scrollTop to **238.5**. Every retained BUYER038 finance row moved **132.5 px** down: RK801 y267.0078 →399.5078; RK804 y446.0078 →578.5078. This violates the owner's explicit same-position requirement even though the top-of-table case passes.

Required correction: preserve the working scroll canvas/anchor across daily changes without exposing accounts outside their valid dated history. Test the bottom boundary and differing date membership, not only scrollTop zero.

## Actual passes

- Exactly three finance columns on Today and Yesterday: balance, topup, selected-day spend. Today values use Oct18 and Yesterday Oct17; yesterday spend is not a fourth field on Today.
- No visible per-input labels on either daily view. Column header contains only RK, status, run, balance, topup, spend, actions; no dates.
- Desktop document width 1384 = scrollWidth1384. The Accounts table and fields fit horizontally.
- Ordinary RK row spacing is 44 px (one run row makes an adjacent 45.5 px span); finance cell block is 268 ×32.7578 px, three compact fields.
- At scrollTop zero all five BUYER038 finance row rectangles remained exactly unchanged on Today↔Yesterday. Their folds remained intact and data changed directly without a loading screen replacing the table.
- Yesterday Enter on RK802 spend focused RK803 spend, preserving the selected-date expense column.
- RK802 More menu contains History and Archive. Neither is an exposed repeated button in the normal row. Opening/closing the menu did not modify data.
- Archived RK801 retains today's entered amounts and yesterday spend, and fields remain disabled, preserving history.

## Limits

An initial fresh-tab authentication spinner lasted roughly two minutes during concurrent Beta startup; it subsequently resolved without a sign-in mutation. This is recorded as environment evidence, not blamed on compact Accounts code without diagnosis. This review did not mutate the owner's live balances/topups, claim quantitative continuous-frame certification, or certify physical touch/Windows/WebKit. Pointer drag is assigned to the independent interaction reviewer.

Evidence screenshot: `scratchpad/038/compact-buyer-round-1.png` (Yesterday compact working rows). The exact scroll/rectangle measurements above were read-only DOM observations after real UI interactions.
