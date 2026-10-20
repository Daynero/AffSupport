# Independent designer review — round 2

Date: 2026-10-18. Actual beta route, independent Chrome tab 766198373. Source freeze requested. UI interactions via cua_repl; read-only DOM geometry and browser console used to verify visual issues.

**Score: 86/100.** Major desktop and mutation defects from round 1 are resolved; narrow layout still has a reproducible page overflow defect, preventing acceptance above 96.

## Confirmed improvements

- D1: desktop sticky captions now stay above visible row contents, with internal table scrolling. Clicking DESIGN038 no longer places captions across its editable fields.
- D2: at 390×844, balance input → enter 100 → Tab now shows focused yesterday-expense field and clear focus ring. Cancel clears the draft.
- D3: keyboard Space on DESIGN038 collapses all social groups; live region says `DESIGN038: місце 2 з 3.` Escape restores the expanded state. Opaque UUID/English announcements no longer observed.
- D4: created DESIGN038B successfully with normal form completion, no false failure.
- D5: created RK 99003802 under DESIGN038B. New row and counter appear immediately and remain after further interaction, without reload.
- Full eight-state name color cycle verified in light theme: yellow → red → blue → purple → pink → orange → none → green → yellow. Accessible name changes each step. Both settled themes are readable.
- 800ms pointer hold on green DESIGN038B RK name starts drag and does not cycle its color; live feedback identifies moving RK, then saving order. This proves long-hold click suppression, not frame-rate timing or an exact 500ms threshold.

## Open issue

**D6 — high: 390px layout widens whole document and focus pans the entire page horizontally.**

1. Set viewport 390×844, fresh accounts page.
2. Fill DESIGN038 balance with 100 and Tab into yesterday expense.
3. Focused input is visible, but date/header/search are now off the left edge. Copy actions and summary still occupy a long desktop row. Screenshot shows clipped toolbar fragments, large blank region above field, and a wide panel.

Read-only DOM evidence after focus:

| Element | Measured width |
| --- | ---: |
| viewport | 390 |
| document scrollWidth | 923 |
| page scrollX | 533 |
| `.team-panel.team-account-space.is-unified` | 907.07 |
| `.team-accounts-sticky` | 873.07 |
| `.unified-finance-summary` | 873.07 |
| `.team-accounts-search` | 440 |
| `.team-accounts-table` | 873.07 |
| internal list | 1380 |

The list may need internal horizontal scrolling, but its parent must remain viewport-contained. Fix shrinking constraints on ancestors and move secondary finance actions into compact menu; verify document scrollWidth equals viewport and focus changes only the intended table scroll owner.

## Observations and limits

- Shared-library build during early review caused HMR `useAuth must be used inside AuthProvider` and blank root. Fresh reload recovered; root stopped concurrent build. Not counted as persistent app failure.
- Immediate light/dark screenshot catches temporary low-contrast theme-transition frame; settled theme is readable. No persistent contrast failure claimed.
- 768px layout observed; a single-line summary truncates rather than wrapping. 200% browser zoom shortcut did not visibly change browser zoom and is not counted as passed.
- Reduced motion and full pointer reorder trajectory/frame timing remain unverified independently. Exact 500ms boundary is not established by 800ms hold.
- Existing archived buyer row retains numbers and `В архіві`; history button is disabled in that immediate archived-day row. Buyer reviewer is independently checking archive correction routes.

No product code edited by reviewer. DESIGN038B/99003802 test fixtures added only in beta.
