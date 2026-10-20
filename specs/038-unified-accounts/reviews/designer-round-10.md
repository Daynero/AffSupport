# Independent designer review — round 10

Date: 2026-10-18. Actual local beta5175, fresh independent Chrome tab766198439. No application code or fixture data changed by reviewer. Browser actions and read-only DOM measurements use cua_repl.

Final reviewed application working-tree SHA256 supplied by root: `f0ff240c19c87564ecb524618049621a91a2be686c72c9b45ae115b6de5f99aa`. Corresponding113-file manifest: `6aeea04d22cab2ddfc550fdd126b820799235aa2f0183ac4f015ae9bad7362b6`. Neither is a packaged-release certificate. Initial pass preceded the final narrow-header CSS correction; final retest followed an explicit build/source freeze and fresh reload.

**Independent observed functional UI/UX score: 97/100.** No reproduced functional blocker in Accounts or the successful lazy editor path. The reported header compression is fixed and retested below; the score does not imply SC004 certification or an exercised failure/retry path.

## Actual follow-up checks

- Fresh direct Accounts route loads the unified financial/account table. Existing historical archived rows and finances remain visible in their applicable day. Main Accounts has no internal navigation tabs.
- Expanded BUYER038, opened “Змінити запуск: BUYER-R3 RUN”, inspected the focused inline editor, then cancelled without saving.
- Daily period details opens with top-up statement selected in Ukrainian. The statement contains the archived historical50USD and8USD entries and active70USD entry, total128USD. Standard Close works.
- At390px switched through the actual EN language control. Accounts dates, actions, finance labels and report labels render in English. Daily statement is readable and Close is visible. Document width390px; report remains inside its modal.
- Keyboard Tab from g1 balance moves to yesterday spend; active input x162–244,y472–494 lies visibly inside the narrow table. No page horizontal overflow.
- Actual Launches navigation loads the empty list, then New launch opens the lazy dialog. Loading status appears before the full editor. Settings, campaign controls, date and URL controls render with English text. Cancel closes it. Reopened in Ukrainian: settings and controls translated correctly, then Cancel closes it. No launch generated or draft saved.
- Returned to desktop1440 Accounts. Unified table remains intact. Restored initial UA locale.

Evidence: [390px English report](../../../scratchpad/038/designer-r10-mobile-report.png), [390px lazy editor](../../../scratchpad/038/designer-r10-launch-mobile.png), [desktop Accounts](../../../scratchpad/038/designer-r10-accounts-desktop.png).

## Header compression found, fixed and retested

At390px the reused Launch editor's “Refresh sources” action is squeezed beside the “Launch basics” heading/description, breaking words over several lines. The button remains clickable; this is a readability/polish defect, not a lazy loading failure. Ukrainian action width measured76.48px; English screenshot shows the stronger compression.

Reproduce: Launches → New launch → Settings at390px, inspect Launch basics header. Selector: `.launch-editor-section-heading > button` / role button “Refresh sources”. Existing source seam: `apps/web/src/styles/components.css` heading rule and mobile override; `LaunchEditor.tsx` source header. Root applied the narrow stack and nonshrinking intact action label; reviewer did not patch runtime.

After announced stable build/freeze, freshly reloaded and actually opened/cancelled New launch in UA and EN at320px and390px. Refresh action now occupies a complete readable line below the heading/description in all four combinations. UA320 action x66–209.83, width143.83px; EN390 x66–193.75, width127.75px. Document widths remain320/390. Evidence: [320px Ukrainian final](../../../scratchpad/038/designer-r10-launch-320-ua-final.png), [390px English final](../../../scratchpad/038/designer-r10-launch-390-en-final.png).

Residual minor polish: at320px the reused editor's compact Settings tab and Generate footer label can truncate visually; their full accessible names remain available and controls are reachable. This is part of the narrow-screen density deduction, not an observed blocked control. Accounts' own financial fields and report were not affected.

## Evidence limits

Launches list is actually empty in this workspace. Accounts inline run text is not an existing persisted LaunchSession detail link. Therefore existing-session detail, network/chunk failure, Retry, and successful recovery from such failure were not exercised; successful new-editor lazy open/close/reopen is the observed result. No synthetic error or production launch was created to manufacture coverage.

During the announced canonical build/HMR, the own page temporarily became blank with an AuthProvider-context error. Fresh reload showed session checking, then recovered the authenticated Accounts route. Classified as a recovered build-time HMR artifact, with no persistent fresh-runtime failure observed. No performance conclusions drawn while root gates were running.

Prior R5–R9 evidence remains scoped as documented. Exact500ms boundary and SC004 continuous-rAF remain uncertified;97/100 is not a performance or production-release claim. Remaining deductions reflect the narrow table/report/editor density and uncompleted quantitative performance proof.

Viewport ownership was coordinated serially with buyer. After final320/390 retest, restored UA, cancelled every editor, reset viewport through the normal API and closed own tab439. No media/zoom overrides added. Explicit UI release sent to root and buyer before buyer resumes.
