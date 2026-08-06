# Accessibility matrix — soty-ui-r01

Recorded: 2026-08-05. This matrix separates automated evidence from checks that require a
human-operated browser. It is not an approval record.

| Check | Scope | Result | Evidence / follow-up |
| --- | --- | --- | --- |
| Axe | Home, light theme | Pass | 0 violations, including 0 serious/critical, from `npm run verify:soty-review` |
| Computed contrast | Light/dark semantic pairs | Pass | 4.5:1 text/action/hover, 3:1 focus thresholds in `tests/soty-review-tokens.test.ts` |
| 320px reflow | Five representative surfaces, both themes, long locale | Pass | No document-level horizontal overflow at 320×568 |
| Long content | Representative fixture content | Pass | Automated viewport matrix uses `locale=en-long` |
| Decoration overlap | Five representative surfaces, both themes | Pass | Automated action/focus bounding checks and captured baselines |
| Keyboard primitives | Disclosure, nested return, modal trap/Escape/restore, segmented control | Pass | Vitest accessibility, disclosure and nested-flow suites |
| Keyboard-only end-to-end paths | Representative flows | Pending human check | Browser automation does not substitute for an operator assessment |
| Real browser zoom at 200% | 1280×720 and 1440×900 windows | Pending human check | In-app browser session was unavailable during implementation |

T064 and SC-007/SC-008 remain open until the two pending human checks are recorded with
browser/version, operating system, surface references and observed results.
