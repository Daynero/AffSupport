# Compact Accounts — independent buyer review, round 2

Application freeze: `d83d4981b266ee6ea7c179d3585c953f15e8a2eddfe9b693c0c659b0f812512f`.
2026-10-18, real authenticated local Beta, Chrome 1384 ×666, Ukrainian, existing dark theme. Same fresh reviewer-owned tab450, closed after testing. No account, finance, theme, language or viewport mutations. Reviewer authored reports only.

**Score: 9.9 /10 for the buyer workflow in the tested desktop environment. No remaining blocking finding in this review scope.**

Round1's actual 132.5 px bottom-clamp regression is corrected. I recreated the exact Today table bottom position through real scrolling, then switched Today→Yesterday→Today→Yesterday→Today→Yesterday with real date buttons. All six observations retained table scrollTop **371**, scrollHeight **704**, and all five BUYER038 finance row x/y/width/height values exactly. Every measured y delta was **0 px**, including both directions and repeated cycles. This is not a top-only test.

Dated membership remains correct: Today has seven social headings; Yesterday five, excluding the two socials created today. The larger retained canvas does not expose those socials on Yesterday. The five retained finance rows keep their original geometry, collapse state and selected-day values; no table-replacement loading screen appeared during the switches. The ordinary row geometry and three date-correct input columns from round1 remain intact, with no repeated field labels or dates in the column header.

The corrected social More control now opens a real anchored menu containing Archive for BUYER038; Escape dismisses it. Archive stays secondary, and no destructive item was selected. Yesterday Enter on RK802 spend again focused RK803 spend. No edit/save request was made.

Read-only measurements: `scratchpad/038/compact-buyer-round-2-measurements.json`. Screenshot: `scratchpad/038/compact-buyer-round-2.png`.

The reload before this retest encountered prolonged Beta boot/browser bridge delays during concurrent heavy verification. Once the static runner ended, the same existing tab loaded and the exclusive browser review completed normally. I did not bypass authentication or fabricate an approval from that delay. This score does not certify quantitative FPS, physical touch, Windows/WebKit, or pointer drag; the separate interaction reviewer owns actual dragging.
