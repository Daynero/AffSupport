# G0 — constitution ratification

| Item            | Value                                                                |
| --------------- | -------------------------------------------------------------------- |
| Amendment       | Constitution 1.0.0 → **2.0.0** (MAJOR)                               |
| Prepared        | 2026-09-09, on the maintainer's authorization (Sync Impact Report)   |
| Ratified commit | `9cc4bf0765ecdb9ca2226200bf26b5ee527b0cbb`                           |
| Branch          | `governance/constitution-2-0-0`                                      |
| Ratified        | 2026-09-12, on the maintainer's explicit instruction in this session |
| Scope           | Principle II; Development Workflow release/deploy gating             |

## What the amendment changed

Release validation is now defined **per phase** rather than as one unconditional
rule, and the canonical manifest-only descendant commit is permitted. This
replaces the prior requirement that the manifest commit equal the packaged
release commit in every case. The exception is deliberately narrow: a later web
commit must descend from the release commit, differ only in the signed stable
manifest for those exact published artifacts, carry its own clean exact-SHA
packaged-beta verification, and leave remote `main` and `beta` matching the
expected manifest commit at final acceptance. Published binaries may not be
rebuilt for it, no tag may move, and no asset may be replaced. Separately scoped
web-only releases keep their existing ancestry and unchanged-input checks.

## Why this gates T015–T016

Those tasks split `verify-release.mjs` into candidate/package and final/deploy
validation — exactly the phase-scoped behaviour this amendment authorizes.
Implementing them first would have meant a release gate enforcing a rule the
project had not adopted. That ordering is the whole point of G0, and it was kept:
no gate semantics were changed before this commit existed.

## What was implemented after it

`scripts/verify-release.mjs` now takes `--mode=contract|candidate|final`,
defaulting to `final` and failing on an unknown mode before it does any work.
`scripts/verify-all.mjs` carries the phase through (`SOTY_RELEASE_VERIFY_MODE`,
`contract` by default, since the aggregator also runs on pull requests where no
tag exists). `package:mac` and `package:dmg` assert the candidate phase; every
`deploy:web*` command asserts the final phase, and a test refuses any command
that reaches a deploy through the contract phase.

T066 rechecks this record against real acceptance evidence; it does not
re-authorize anything, and it cannot be satisfied by this file alone.
