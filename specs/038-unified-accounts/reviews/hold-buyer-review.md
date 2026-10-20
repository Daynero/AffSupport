# Buyer review — hold and identity polish

2026-10-18. Independent source and recorded-artifact review; no UI interaction, runtime edits or test execution in this pass. **97/100 for the reviewed buyer interaction changes. No blocking defect identified.** This score is scoped to the changes and supplied evidence; it does not independently re-certify the complete live buyer workflow.

## Reviewed evidence

- Source: `AccountHoldProgress.tsx`, `accountCollision.ts`, `AccountReorderProvider.tsx`, `AccountGroup.tsx`, `AgentRow.tsx`, `AgentIdentity.tsx`, account CSS and palette tokens; read the hold/collision regression tests without running them.
- Root-recorded browser artifacts: `scratchpad/038/hold-center-browser.json`, `hold-ring.png`, `accounts-polish-final.png`, `decoration-grips-pointer.png`, `decoration-grips-pointer.json`, `hover-final-responsive.json`, `hover-final-opaque-rk.json` and `hover-final-archive-red.json`.
- Responsive and older opacity artifacts name application fingerprint `d013b628c451ed6179bd26093dd4ce76271ba6f81003c22c7e4d1c6c210150aa`. The hold-center artifact itself does not embed a source fingerprint; root must retain its final source association. These are root's browser observations, not independent measurements by this reviewer.

## Buyer assessment

1. Plain RK identities now use one text label with the full underlying ID in its title. Search no longer adds identity marks or a separately emphasized suffix pill. The screenshot reads as a stable account list; full-ID copy remains a separate control.
2. The seven decorations remain explicit palette choices plus none. Fill occupies the identity band and rail, stopping before status, runs and finance controls. Their solid tokens survive hover/drag surfaces, avoiding the washed-out effect in earlier screenshots. Status still has a separate word and dot: the decorative red is not used to infer ban state.
3. Removing visible grips does not remove reorder capability. The pointer sensor explicitly activates on the complete source element, excludes embedded form controls/buttons/links, and deliberately permits the name-color button. Short click still cycles decoration; successful drag suppresses the ensuing click. This preserves financial entry and the user's requested card-hold behavior.
4. The circular progress indicator follows the library's actual delay constraint lifecycle, not a separate timeout. It appears at the grab point, is non-interactive and hidden from accessibility, and clears on activation/abort. Source uses 500ms and 5px tolerance. Read-only review of the tests found explicit499/500ms, early-release, excessive movement, abort and portal cleanup cases. Recorded pre-lift state reports zero captures and0.5s animation; final recorded state reports no ring or captured item remaining.
5. Center-based collision compares complete measured row centers and ignores the pointer's arbitrary grab offset. That directly addresses a buyer pulling a tall multi-run RK from its top or bottom. Source retains same-parent sortable acceptance, so geometric choice does not authorize moving RK into another social. The tests cover mirrored tall-row movement and missing shapes. The browser artifact records a103px row moving to position6of9 with an opaque complete source.
6. Social evidence shows all groups temporarily folded during capture and an opaque54px source. Final state reports unfolded source, zero grips, zero identity marks, no horizontal overflow and no lingering capture. Responsive measurements report zero finance/run overlaps or escaped run buttons at1448/1000/800/390 widths.
7. Removing grips retains keyboard alternatives through the More-actions menu's move commands and advertised Alt+ArrowUp/Down shortcuts. Financial and archive code paths were not changed by this narrow interaction review.

## Defects, improvements and limits

No new P0/P1/P2 defect is supported by the reviewed source and evidence. Minor improvement: a first-use, unobtrusive description that holding the card reorders it would improve discoverability now that no grip is shown; the progress ring only teaches after a user has already pressed. This is optional and should not add persistent visual clutter.

The remaining three points reflect interaction discoverability and the breadth of unverified device behavior, rather than an invented blocking defect. Static screenshots cannot demonstrate smooth frame pacing, and the progress PNG alone cannot prove exact activation timing. No physical touch, Windows/WebKit, screen-reader session, out-of-bounds cancellation, continuous-rAF frame budget or full seven-color persistence cycle was independently executed here. Existing regression tests and root's live observations remain separate evidence. No implementation fixes are requested from this review.
