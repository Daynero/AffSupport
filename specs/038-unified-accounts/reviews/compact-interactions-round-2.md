# Independent interaction review — round 2

App freeze `ccbba6ae4ff8d9ef79257a6f2f63129e944b531e6fcff5ffb5eea2ea92326aea`, Chrome real beta, synthetic 50-social/500-RK team, 1384 × 666. Reviewer made no runtime/test changes or stored financial/order edits.

**Score: 7.5/10. A real social movement cancellation defect blocks acceptance.**

## Reproduced defect: social header ownership corrupts after movement and Escape

1. Focus the first social's real `[data-reorder-keyboard]` activator and press Space.
2. All socials temporarily fold. Press ArrowDown through native keyboard input.
3. The captured complete social header moves down by `66.1953125 px`; the library records an actual translate and a 250 ms easing transition. The neighboring social previews before it.
4. Press Escape and allow the drop/cancel animation to settle.

The status correctly announces cancellation, but the settled DOM is malformed:

- First `.team-account` section has only `.team-account-body`, **zero headings** and 10 RK rows.
- Second section contains **two** `.team-account-head` elements (`g02`, `g03`) and one body, 10 RK rows.
- Third section (`g04`) still has the expected single header/body.
- Table scroll jumps to `2063.5`; the captured `g02` heading ends at `y=444.46875` rather than its `y=307` keyboard capture position.
- There are no remaining drag styles, so this is not merely a screenshot taken during the drop animation.

Likely cause from read-only source inspection: the social sortable ref targets only the header inside a separate `.team-account` section, allowing the library's optimistic DOM reordering to move headers between different sections while their RK bodies remain behind. The whole semantic sortable unit and intended collapsed feedback need a consistent parent ownership strategy.

Evidence: [settled cancellation screenshot](../../../scratchpad/038/compact-interactions-cancel-corruption.png). Root has the exact sequence and tab 766198456 remains available for the next isolated retest.

## Additional evidence and limitations

The native held-click plus native wheel attempt did activate capture and retain exact full-source size, but the wheel API did not move the pointer; source translation stayed zero. It therefore does not establish actual pointer-follow behavior. Raw CDP input remains explicitly unavailable due the bridge's paused document response restriction and was not bypassed.

Round 1's exact full-content RK/social held-source geometry checks remain valid for the unchanged drag provider. Actual keyboard movement now has evidence, and it exposed the cancellation defect above. No frame-rate, physical touch or platform certification is claimed.
