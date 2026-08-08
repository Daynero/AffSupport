# Verification evidence — soty-ui-r01

Recorded: 2026-08-05.

## Completed gates

| Command | Result |
| --- | --- |
| `npm run format:check` | Pass |
| `npm run lint` | Pass |
| `npx vitest run tests/soty-review-*.test.*` | Pass: 15 files, 31 tests |
| `npm run build:soty-review` | Pass |
| `npm run verify:soty-review` | Pass: 104 interactions, 0 isolation violations, 50 screenshots, 0 axe violations |
| `git diff --check` | Pass |

The 50 versioned PNG baselines cover five representative surfaces, light/dark themes, five
viewports from 320×568 through 1440×900, long-content locale and reduced motion. They are in
`baselines/` and use the deterministic
`iteration--surface--state--theme--viewport--motion.png` convention.

## Blocked repository gate

`npm test` stopped the sequential quickstart run: 682 tests passed, 23 failed and 6 were
skipped. Twenty failures reported `spawn ffmpeg ENOENT`; the remaining image/WebP assertions
also showed failed media processing caused by the unavailable `ffmpeg` executable. Because
the command failed, the subsequent `npm run build:web` command in that sequential run was not
executed. No production code was changed to work around the environment.

## Human gates still open

- Keyboard-only representative-flow assessment.
- Real 200% browser zoom at the required window sizes.
- Three 20-participant usability/perception studies.
- Owner review and written approval.

T068 remains open until the missing FFmpeg prerequisite is restored, the complete quickstart
command sequence passes, and the human checks are recorded.
