# Local beta hover fixture

Created on 2026-10-18 at 09:53 UTC in the existing **Beta Workspace**
(`22222222-2222-4222-8222-222222222222`). This is additive local data, not a
workspace reset or a production seed.

- 10 SOCs: `DEMO-HOVER-01` through `DEMO-HOVER-10`.
- 10 RK in each SOC: 100 RK total, with identifiers `demo_hover_01_01` through
  `demo_hover_10_10`.
- 40 free RK and 60 started RK; each started RK has one, two or three launches.
  There are 120 launches total, including short and long Ukrainian names for
  checking hover actions and text truncation.
- No synthetic financial entries, account secrets, tags or name colours were
  added. Existing stored folds are not changed.

Run with `node scripts/seed-accounts-hover-fixture.mjs`. The script hard-codes
and validates the loopback beta database, verifies the expected workspace and
fixture owner, and calls the normal `create_team_account`,
`add_team_account_agent` and `add_team_agent_run` domain RPCs inside one
transaction. Normal triggers append ranks and maintain placements, revisions
and realtime signals.

Before committing, the script compares all pre-existing account, RK, launch
and finance rows with the same rows after creation. Their SHA256 hashes match:
`a9991af9903863e49f501b9af74135736acc3221a951287cbe76097f4500d4b1`.
No pre-existing values, ranks or archive states changed.

The ignored local manifest at
`scratchpad/038/accounts-hover-fixture.json` contains every generated SOC, RK
and launch UUID, creation time, counts and preservation hashes. A second run
returned `reused: true` with exactly 10 SOCs, 100 RK and 120 launches and wrote
no database data. Later user edits to these rows are preserved; the rerun does
not repair or overwrite them. A fixture-name collision without a manifest
fails without changes instead of guessing which rows belong to the fixture.

The local script was formatted with Prettier. Both the initial creation and
the rerun completed successfully. Visual hover verification is recorded by
the separate UI review.
