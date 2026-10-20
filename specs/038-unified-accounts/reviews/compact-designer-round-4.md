# Compact accounts — independent designer, final round 4

**Design score: 9.9/10 for the revised presentation and tested responsive layouts.** No remaining actionable presentation defect was found in this review's scope. Actual drag translation, keyboard ordering and cancellation are scored by the independent interaction reviewer; this score does not certify those paths or substitute for that review.

Final application freeze `b330a0350a23072527cefa870bf0ce9855ce826802d99bec5d226b0f0d25642e`. Phone CSS is unchanged from `9c111aab6fed22f28de121d9aa16edb79ef53e0a8eaa7602147240e56fcfeb95`.

## Evidence and independence

This designer authored no runtime code or tests. Rounds1–3 used the designer's own actual authenticated beta tabs453/466, native pointer clicks, screenshots and read-only DOM geometry. The final phone capture was operated by the independent interaction reviewer because the designer's browser binding repeatedly timed out after HMR. This designer independently opened and inspected the resulting PNG and JSON; the capture author's identity is explicit rather than presented as a new personal UI run.

The final artifact `scratchpad/038/compact-phone-busy-final.png` with measurements `compact-phone-busy-final.json` shows a390×844 stress-fixture view, five long runs, and all FOUR busy-RK actions. Table client/scroll width is324/324; document390/390. The actions occupy a98×64 cell atx251; their30×30 bounds arex259/293 andy589.20/623.20, all inside that cell and the table. Thus the round3 clipping defect is resolved. All three financial input contents remain82 px wide, and headings are full readable words with no dates or repeated row labels. The long row's511 px height contains five actual multiline runs and is not an empty inflated overlay.

The designer's earlier actual desktop checks remain applicable because the later presentation fixes are restricted to the phone breakpoint:1384×666 document1384/table1259/1259, ordinary RK44 px, one-run RK47 px;1000/table926/926 and768/table694/694. These show compact selected-day balance/top-up/spend columns without horizontal scrolling. Actual RK More menu contains History and Archive; normal row shelves do not expose them.

## Date-position correction

Round1's199 px jump was captured using a semantic locator click, which auto-scrolls a sticky button before delivering the click. Native coordinate clicking in round2 demonstrated Today→Yesterday and Yesterday→Today with document scrollY234, document scrollHeight900 and table top247.5546875 unchanged. Input labels remained absent. Do not cite the old locator screenshots as an unfixed native pointer defect. The independent buyer's subsequent bottom-of-table/native-day cycles provide separate position evidence.

## Limits and cleanup

No physical touch, Windows/WebKit or continuous frame-rate certification is claimed. Browser viewport was reset to1384×666 by the interaction reviewer after the final capture. No fixture values, theme or language were changed by this designer. Old own tab466 remains pending cleanup because its browser binding times out; parent was informed. No user tabs were closed or modified.

## Applicability addendum — search visibility fix

Application freeze `2d721f61ae2f5089a8db19ca5bb0c2d453829da3a5b3730a9c4fafe39786693a`. **Independent design score remains9.9/10 within the presentation/responsive scope above.** This addendum is a source/evidence assessment, not a claim of another designer-operated browser run.

I independently inspected the new `AccountSpace.tsx` layout effect. Its dependencies are exactly search, occupancy and marker: before paint it removes the daily-navigation minimum-height reservation from the panel/list and resets the table scrollTop to0. Date is deliberately not a dependency. This makes a changed search/filter reveal its first result while leaving day-only transitions on their existing preserved-position path. The change introduces no finance writes, changed grid tracks, input sizes, labels, action visibility or drag-provider logic.

I read `compact-buyer-round-4.md`, which documents an actual final-freeze beta retest: native Today/Yesterday transitions retain all five RK rectangles with0px delta at both normal and bottom positions; after the retained bottom371 canvas, search88003802 reveals its matching RK at y537.20–581.20 inside the666px viewport with table scrollTop0; the single launched occupancy result is also visible with scrollTop0. Document width remains1384/1384. Those are the buyer's observations, not relabeled as mine. They directly exercise the newly corrected regression and support carrying forward the existing design conclusion.

The phone CSS and earlier measured responsive geometry are unchanged. Marker-filter resetting is supported by the same inspected effect dependency but was not separately exercised in that buyer UI run. The interaction review still independently owns middle-social movement and cancellation acceptance; this addendum does not pre-approve its pending result.

## Applicability addendum — deep-scroll social capture

Current application freeze `36010b798cea217f50dfb94782395c34cf04aa8245d5f8519faa2561ea77048c`. **Independent design score remains9.9/10 for the tested presentation and responsive scope.** Round6's interaction score9.3 explicitly superseded its earlier interaction acceptance; the subsequent actual Round7 retest, not the earlier score, supports this addendum.

I inspected the minimal provider change and its regression. The viewport anchor now prefers the matching heading inside the library's flow placeholder, falling back to the source heading. That is the correct geometry to measure while feedback fixes the actual source under the pointer and peer bodies fold. The new regression separately models a fixed source and moving placeholder: retained scroll1000 becomes200 while collapsed, then restores1000 on cancellation without a reorder RPC. No date logic or CSS geometry changed.

I independently read the actual `compact-middle-social-fixed-proof.json` and Round7 report. In the native hold the table moves34867→1451, RK bodies are absent, and compact neighboring headers g23/g24/g26/g27 sit immediately around g25. Captured source width1258.95 and height54.20 retain the actual grab origin. Release restores table34867, outer234, g25y416.125, all50 expanded states and one heading per section. The separate actual keyboard25→26→Escape check restores the same ownership and viewport. These observations belong to the interaction reviewer and are explicitly attributed.

During artifact inspection I spotted that the initially named hold PNG contained restored run content inconsistent with its accompanying in-flight JSON. The interaction reviewer confirmed screenshot delivery occurred after restoration and corrected its name/report. It is now `compact-middle-social-restored-context.png`, and is not treated as visual proof during a held gesture. The actual in-flight DOM measurement and separate keyboard observations support the fixed-neighbor conclusion. No new designer-operated UI run, continuous FPS or unsupported platform certification is implied.

## Final applicability — bounded active social canvas

Final application hash `7b457a1575537ecae15dd0d59e2c4eeb529660e54cb26c6aa2af04b95b91f927`. **Independent design score:9.9/10 within the presentation/responsive and evidence-assessment scope described above.** Round8's additional blank-tail defect superseded Round7's interaction closure; only the subsequent Round9 actual verification supports this final conclusion.

I independently inspected the provider delta and its expanded regression. The anchor records the frozen canvas minimum height. During active social capture it temporarily sets that floor to the physical table clientHeight; after the gesture it restores the original floor before measuring the flow placeholder and restoring position. Thus compact social headers define the active scroll range instead of the former expanded71900 px reservation. The regression asserts333 px during capture, restores71900 px afterward, preserves the1000→200→1000 anchor sequence, and confirms cancellation sends no reorder RPC. CSS, finance, selected-day switching and search handling are unchanged.

I opened and inspected both `compact-drag-bounded-tail.png` and its JSON, then read `compact-interactions-round-9.md`. The actual persistent-capture screenshot visibly agrees with the JSON: g25 remains captured while final compact peers g47/g49/g50 surround it; no empty tail occupies the working viewport. The separate native-hold JSON confirms the full source and grab origin remain intact, with neighbors visible. After the actual5000 px wheel, tableTop clamps2994 with scrollHeight3328/client333, and g50 stays visible at y528.07. Escape restores table34867/page234/g25y416.125, all50 expanded states and exactly one heading per section. This capture has no held-click screenshot deadline ambiguity.

These final gesture observations were produced by the independent interaction reviewer; this designer's work here is independent source, regression and artifact inspection, not another claimed personal UI run. The unchanged earlier desktop/phone geometry and actual buyer day/search checks remain applicable. Quantitative FPS, physical touch and other platforms remain outside the verified scope.
