# Claude Code — start here

**[`AGENTS.md`](AGENTS.md) is the agent guide for this repository.** Read it
before changing anything: it covers the analytics CLI, the verification
command, the dev and beta builds, releases, and cross-platform agent code.

This file exists because Claude Code loads `CLAUDE.md` by name and nothing
else, and a guide nobody opens is a guide nobody follows. Everything below is
a pointer to the document that owns the subject — when the two disagree, the
other document wins.

## The three that are easiest to break by accident

**Anything visual goes through the design system.** Take the component from
`apps/web/src/components/ui/` instead of writing one, and name a token from
`apps/web/src/styles/tokens.css` instead of writing a value. That file is the
only place in the product allowed to spell a colour, a radius, a type step or
a duration, and its exemption list is empty. The rules are
[`docs/DESIGN.md`](docs/DESIGN.md) (what this product does) and
[`docs/DESIGN-PRINCIPLES.md`](docs/DESIGN-PRINCIPLES.md) (why). In a dev build
the route `/design` shows every component and variant side by side.

**Verify with the one command.** `npm run verify` — it runs the same gates CI
runs, through `scripts/verify-all.mjs`, and reports one result. Do not assemble
your own list of checks; it drifts from CI the first time a gate is added.

**This machine runs one heavy thing at a time.** Check `uptime` before starting
a build or the suite, and run vitest single-worker
(`--pool=forks --poolOptions.forks.singleFork=true`).

## Where the design system is enforced, not just described

A rule nothing enforces lasts until the next hurry. These run in CI:

- `scripts/check-design-tokens.mjs` — fails on a raw colour, duration, radius
  or font size outside the token layer, and on a transition of a property that
  forces layout.
- `scripts/verify-styles.mjs` — fails on a `var()` naming a property nothing
  declares, which CSS drops silently.
- `tests/design-token-contract.test.ts`, `tests/stylesheet-integrity.test.ts`,
  `tests/ui-consistency.test.tsx`, `tests/design-components.test.tsx` — the
  inventory's own contract, and the stylesheet's.

The component contract itself is
`specs/021-design-system-redesign/contracts/components.md`; what the migration
learned, and the three places it deliberately did not follow its own task list,
are in `specs/021-design-system-redesign/findings.md`.
