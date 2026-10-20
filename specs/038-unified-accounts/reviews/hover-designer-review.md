# Independent designer — hover/layout follow-up

Actual prepatch application `f55233dbed9aa59f418914ef87cfa32efa9ed1d19ec562d7adf184c6a8b9e346`; marker CSS fix source inspected at `d013b628c451ed6179bd26093dd4ce76271ba6f81003c22c7e4d1c6c210150aa`.

**Current assessment:9.6/10 on the actual prepatch UI; final9.9 acceptance pending actual postpatch evidence.** Source inspection alone is not relabeled as a completed UI retest.

## Actual independent UI checks

Fresh own Chrome tab499, real authenticated main Beta, Ukrainian/dark, isolated existing DEMO-HOVER-01 through Search; no account, finance or tag values were edited. Desktop1448×1525, then1000×1000,800×1000 and390×844 via supported viewport controls.

- Native CDP mouseMoved over a busy RK's run text caused **0px maximum x/y/width/height delta across all10 RK rows**, including three-run rows. No error banner was present during that comparison.
- Hovering the SOC action shelf: title right1169.09, actions left1181.09, **12px separation**. All six actual header buttons (collapse plus five actions) passed center-point `elementFromPoint(...).closest('button')` identity checks; none was hidden beneath the title. Header height53.20 and actions30px.
- Tables/documents fit all tested widths:1000table926/926,800table726/726,390table324/324; document width equaled viewport width. No finance-cell/run-cell rectangular overlaps occurred. All12 run text and action containers stayed inside their own run rows. Phone SOC actions occupied their own row inside its324px header.
- The only newly found blocking geometry defect was `.team-agent-run-mark`: its invisible button was44.195px high inside each30px run row, extending14.195px over the following row. Edit/delete buttons were30px. Reported to root before any acceptance.

Evidence saved in `scratchpad/038/hover-designer-desktop.png`, `hover-designer-800.png`, `hover-designer-390.png`.

## Fix inspected; actual retest incomplete

Root added scoped marker min-width/min-height0, width/height100%, padding0. That directly addresses the inherited button minimum without changing visible row grid geometry. I inspected this source change independently. However, the subsequent fresh tab503 first showed “Не вдалося завантажити акаунти.” One explicit Repeat recovered the actual DEMO rows; no application errors were returned by the error-level console read. This transient read failure is recorded separately from the successful prepatch hover geometry and is not attributed to hover.

A four-width postpatch DOM batch exceeded the30s browser-tool deadline and reset its kernel before emitting any measurements. Subsequent browser binding recovery timed out as well. Therefore **no postpatch marker containment, archived-red-dot or opaque RK/SOC capture check is claimed by this reviewer yet**. The source contains the requested red archived-dot token and opaque capture rules, but actual computed/visual verification remains pending root/interaction evidence.

No browser CLI, injected page mutation, unsupported automation bypass, theme change or fixture write was used. Native CDP input was used only for ordinary pointer movement. Before the final failed batch the viewport had been reset to the user's1448×1525; the batch's last successfully applied override is unknown and must be observed/reset. Own tab503 remains for parent recovery; tab499 was closed. Browser exclusive control was explicitly released to root after the timeout, with no further UI calls.

## Postpatch containment evidence assessment

I independently opened `scratchpad/038/hover-final-responsive.json` and `hover-final-phone.png`, captured by root on final application `d013b628c451ed6179bd26093dd4ce76271ba6f81003c22c7e4d1c6c210150aa`. These are root-operated actual UI observations, not presented as another designer-operated browser run.

At1448,1000,800 and390 widths, all12 marker buttons now match their30px run lines exactly, with zero escaped buttons, zero SOC title/action overlaps and zero finance/run overlaps. Document widths equal the viewport; table client/scroll pairs are1319/1319,926/926,726/726,324/324. The phone screenshot confirms readable whole column headings and a separate, unobstructed SOC action row. This evidence closes the actual marker-hit-area finding from my prepatch review. Root reset the viewport afterward.

Final assessment still awaits actual archived-red-dot and opaque dragged-source evidence requested in this follow-up scope. Source rules alone are not counted as completed interaction proof.

## Archived state and opaque RK evidence assessment

I independently opened root's actual `hover-final-archive-red.json/.png` and `hover-final-opaque-rk.json/.png` on the same final hash. The archived state is visibly labeled “В архіві” and its computed dot `rgb(244,119,106)` matches the error token `#f4776a`; free/busy states remain green/yellow. The actual captured RK retains all three inputs and the original1319.117×65 rectangle, with opaque `rgb(28,23,37)` background, opacity1 and isolate. Cancellation ends with zero active captures. These are root-operated observations; my independent work is artifact/source assessment. SOC opacity and final interaction review are still pending before broader final acceptance.

## Latest hold-progress, center sorting and opaque SOC assessment

**Updated independent design assessment:9.9/10 within the tested presentation and inspected-evidence scope.** This supersedes the provisional9.6 above after the discovered marker defect was closed by actual four-width evidence and both opaque-source states were measured. The parent must attach the latest application hash after its freeze refresh; `d013…` identifies the earlier containment measurements, not the subsequent hold-progress source change.

I independently inspected `AccountHoldProgress.tsx`, the provider integration, `accountCollision.ts` and their regression scenarios. The decorative progress ring follows the actual library Delay lifecycle:500ms/5px tolerance, clears on activation and abort; it is portaled outside table clipping and does not intercept pointer events. Tests cover499/500ms, early release, movement cancellation, explicit abort and portal cleanup. The collision detector measures complete source/target centers, so differing grab points do not bias up/down neighbor selection; tests cover mirrored tall-row boundaries, top/bottom grabs and missing shapes.

I opened root's actual `hold-center-browser.json`: before lifting, there is one24×24 ring centered at the pointer470/880, duration0.5s, with zero active dragged sources. After capture, the ring is absent. The actual tall RK source keeps103px height and opaque background while moving upward; the live position is6 of9. The SOC actual source is a SECTION with opaque `rgb(28,23,37)`, opacity1,54.195px height and temporarily folded groups. Final state has zero captures, zero rings, expanded original group, no visible grips and no horizontal overflow.

I also opened `hold-ring.png` and `hold-social-opaque.png`. The latter visibly confirms the solid social surface and shadow. The former does not visibly show a ring, likely because the screenshot was delivered outside the500ms pre-lift window, so it is **not** used as visual evidence of ring presence. The actual pre-lift DOM JSON supports presence/location and computed animation duration; the source/tests support lifecycle. This distinction is intentional.

These latest browser observations were operated by root; I independently evaluated their source/tests/DOM/visual evidence. My personally operated actual hover test remains the earlier stable0px comparison. Quantitative continuous-motion/FPS, every focus permutation, physical touch and other platforms remain unverified;9.9 is a scoped review judgment, not an exhaustive performance/platform certificate.

Final applicability fingerprint supplied after the runtime freeze: application `8efff37a7baaa4bf6bfef6294e59ad93c34acac4e256897d0db033c7f2152291`, full126-source fingerprint `2138eee2f3d9025cc46c7204e90b48bbe30e025821bdd4bf1fbaa3a4d2a2bf24`; inventory in `reviews/hold-center-source-manifest.json`. The latest9.9 scoped assessment applies to this freeze. Earlier d013 measurements retain their original capture hash and are carried forward by inspection of the subsequent ring/center changes, not relabeled as fresh personal UI observations.
