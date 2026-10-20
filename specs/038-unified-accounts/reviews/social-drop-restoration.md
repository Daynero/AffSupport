# Expanded SOC drop restoration

The owner reported expanded SOC content reopening inside dnd-kit Feedback's compact fixed-size source when moved upward. Restoration now waits for actual removal of Feedback dragging/dropping/popover state; it does not use a guessed timeout. All SOCs stay transiently folded during settlement. The observer is disposed on unmount/new capture, and removed sources release the guard. Membership revision cancellation no longer runs again during settlement.

The canvas records its original min-height before capture rather than preserving the temporary freeze. Restoration removes that freeze and clamps the heading anchor below sticky column captions. Personal folds, inline editor state and finance drafts remain intact. Existing reorder flow signals and API behavior are unchanged; observer state collects no content or coordinates.

## Actual beta acceptance

Native500ms capture of expanded DEMO-HOVER-02, moved upward before01, then released: actual dropping source still had0 expanded groups and a54.2px compact source. After Feedback cleanup:0 active/drop surfaces, DEMO-HOVER-02 expanded, canvas minHeight empty; heading top512.5px exactly matched caption bottom512.5px. No overlap. Reverse native move restored01/02/03 order;02 was folded back to its original state and search restored blank. Existing financial values and tags were untouched.

Evidence: `scratchpad/038/social-drop-lifecycle.json`, `social-drop-restored.png`. Independent source audit found no blocking lifecycle race.

Validation:31/31 tests PASS across drop-restoration, account-order and SOC-order suites, including live MutationObserver cleanup/removal/disposal cases and existing draft/fold preservation. Targeted formatting and diff check PASS. Web typecheck result recorded below.

Web typecheck (`tsc -b apps/web`): PASS.
