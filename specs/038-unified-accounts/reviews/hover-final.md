> Later owner refinements (plain identity bands, no grips, actual hold progress and full-row center sorting) are finalized in [hold-center-final.md](hold-center-final.md), with final source fingerprint and88 green regression/budget tests. This earlier hover snapshot retains its original scope.

# Accounts hover, archive dot and opaque drag follow-up

Application freeze: `d013b628c451ed6179bd26093dd4ce76271ba6f81003c22c7e4d1c6c210150aa`.

The owner reproduced real hover defects after the previous compact-layout acceptance. The old9.9 scores are historical and are not reused as proof here. Current UI review and validation are recorded below when completed.

The SOC header inherited the old narrow action track while its title retained a sticky opaque background. Hover revealed controls underneath that title. The fix gives title/actions separate tracks, removes the sticky slab, sizes controls consistently and explicitly preserves the grid below1000px. Phone actions occupy their own row. Long-run truncation targeted a nonexistent class; it now applies to the real text span with a full-name title, bounded note/age/action tracks and reserved30px controls. Medium widths use a second status/note row so buttons remain inside their own cells. Hover opacity changes never change geometry.

Archived status now wins over free/busy for both the label and its red dot. Captured/dropping original SOC/RK sources have a fully opaque themed surface, full opacity and a token shadow. The library retains original-source ownership, dimensions, grab point and collision/animation behavior.

[Fixture proof](hover-fixture.md):10 new SOCs,100 RK,120 sample launches in the main local Beta Workspace. Existing account/RK/run/finance hashes matched before/after. An immediate rerun reused the same fixture without writes or duplicates. New records contain no fake financial entries.

[Independent source audit](hover-source-review.md) found and closed the tablet flex/grid cascade defect and checked archive/drag selector precedence. Its9.9 is explicitly a source-quality score, not a fictitious browser score. Actual UI checks and current-source validation remain separate.

The first targeted run passed70/72 tests but two unrelated existing social tests exceeded their5-second deadlines under machine load. Both then passed without changing timeouts. The complete final targeted rerun subsequently passed72/72 in31.34seconds with unchanged timeouts. The only later runtime adjustment bounds the absolute marker button to its visible run line; its geometry is checked in the actual UI.


The independent designer actually checked1448,1000,800 and390px before the last marker fix: native hover retained all10 demo RK rectangles with0px deltas, every SOC control was hittable, title/actions had a12px gap, no horizontal overflow or finance/run overlap appeared. That review found a real44.195px global minimum on the invisible marker button over a30px run line. The scoped correction removes that minimum and constrains its full hit area to the run. The final actual recheck remains required; failed/timeout browser batches are not described as proof.

The project layout-check script now checks cell containment/overlap, SOC title/action collision and escaped run button hit regions, with intentional responsive rows allowed. It is a future geometry regression guard, not a browser test claimed to have run during this task; UI execution uses the approved computer-use tools.
