# Quickstart — Validating the 2FA Notebook

How to run this feature and prove it works. Commands are written for this
machine's constraint: **one heavy process at a time**, `nice`d, with Vitest
pinned to a single worker. `npm run verify` / `verify:release` are deliberately
absent — run the gates below one at a time instead.

Check the machine is idle before starting anything heavy:

```bash
uptime
```

---

## Prerequisites

- The shared package builds before anything consumes it — its `dist` is
  committed and every consumer validates against it:

  ```bash
  nice -n 15 npm run build -w @video-compressor/shared
  ```

- The local Supabase stack, for the migration and the RPCs. The beta stack
  brings it up along with the web app:

  ```bash
  nice -n 15 npm run beta:up
  ```

  Web at `http://127.0.0.1:5175` (the Beta Tester account is already signed in),
  Supabase at `http://127.0.0.1:54321`. The desktop agent is **not** needed for
  this feature — that is one of the things to verify.

- Apply the new migration **to the local stack**:

  ```bash
  docker exec -i supabase_db_wishly psql -U postgres -d postgres \
    -f - < supabase/migrations/20260903100000_two_factor_notebook.sql
  ```

  Not `npx supabase db push`. The CLI in this repository is linked to the remote
  project (`types:supabase` passes `--linked`), so `db push` would apply this
  migration to production from a developer's machine. Production migrations go
  through the release process, never from here.

---

## Scenario 1 — The algorithm is the same one phones use

Proves SC-002 and the whole of [`contracts/totp.md`](./contracts/totp.md), with
no browser and no database.

```bash
nice -n 15 npx vitest run tests/totp.test.ts \
  --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

**Expected**: the RFC 6238 appendix-B vectors pass at all six timestamps,
including `20000000000` (past 2038 — a counter truncated to 32 bits fails here
and nowhere else). Base32 accepts lowercase, spaces and `=` padding, and rejects
`0`, `1`, `8`, `9`. `otpauth://` yields both secret and label.

Cross-check against a real authenticator once, by hand: store
`JBSWY3DPEHPK3PXP` in a phone app and in the notebook, and compare the digits
within the same 30-second window. They must match exactly.

---

## Scenario 2 — Storage keeps other people out

Proves FR-006, FR-007 and SC-006 against the real migration chain on PGlite,
with the vault stubbed by `tests/support/team-db.ts`.

```bash
nice -n 15 npx vitest run tests/two-factor-sql.test.ts \
  --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

**Expected**, with `auth.uid()` set to one person and then another:

- Create returns a row; the seed comes back through `list_two_factor_entries`
  byte-identical to what went in.
- The seed is **not** in `private.two_factor_entries` — the column holds a
  `vault_secret_id`, and the plaintext is only in the vault.
- A second person's `list` returns nothing of the first person's.
- A second person's `update` and `delete` on the first person's id both raise
  `ENTRY_NOT_FOUND` — the same code as a genuinely missing row, so ids cannot be
  probed.
- Delete removes both the row and its `vault.secrets` entry; no orphan is left
  behind, and neither does a failed create.
- A direct `select` on the table as `authenticated` returns nothing: RLS is on
  and there is no client policy.

The pgTAP file asserts the same non-owner isolation against a real Postgres:

```bash
npx supabase test db
```

---

## Scenario 3 — One press, code on the clipboard

Proves FR-014 – FR-018 and SC-001 in jsdom.

```bash
nice -n 15 npx vitest run tests/two-factor-ui.test.tsx \
  --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

**Expected**:

- Pressing generate-and-copy writes six digits into the row and calls
  `navigator.clipboard.writeText` with the same string — and does so **without
  an intervening `await`**, which the test asserts by resolving no promise
  between the click and the write.
- A rejected `writeText` produces an error toast, not a success one, and leaves
  the value on screen to be selected by hand.
- A code stops being presented as current once its step has passed.
- The copy button copies the stored seed unchanged, without needing a reveal
  first.

---

## Scenario 4 — The whole thing, in the browser

With the beta stack up, open `http://127.0.0.1:5175`.

1. **The tool needs no desktop app.** With the agent **not running**, the
   notebook's tile on the home screen opens the tool directly — no "install the
   local app" dialog, no setup screen (FR-002). Every other tool still shows its
   dialog, which is the check that the registry change is scoped.
2. **Add.** Paste `JBSWY3DPEHPK3PXP`, name it, save. One row appears, on one
   line, showing the name and a `2fa` marker rather than the seed (FR-022).
3. **Paste a URI instead.** `otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example`
   into an empty form fills the name from the label and stores the seed.
4. **Copy the seed**, paste it into a text field — it is the original string.
5. **Generate and copy**, paste — six digits, matching a phone authenticator
   holding the same seed.
6. **Reveal** one row; only that row shows its seed. Reload — every row is back
   to the marker (FR-023).
7. **Search.** Type part of a name, then part of a seed; both narrow the list.
   Scroll a long list — the search field stays pinned (FR-019). A query matching
   nothing shows the "nothing matches" state, not the "notebook is empty" one.
8. **Edit** a name — the row keeps its position. **Delete** with confirmation —
   the row is gone after a reload.
9. **Second device.** Sign in in a private window; the same notebook is there
   with no export step (SC-005).
10. **Wrong clock.** Set the system clock forward two minutes; a warning appears
    above the list (D6 in `research.md`). Set it back; the warning clears on
    reload.

Confirm the migration ran and the seed really is in the vault:

```bash
docker exec supabase_db_wishly psql -U postgres -d postgres \
  -c "select id, name, vault_secret_id from private.two_factor_entries;"
```

The `name` is readable; there is no seed column to read.

---

## Scenario 5 — No seed escapes

Proves FR-008 and SC-007. With the browser devtools open, run the whole of
scenario 4 and then check:

- **Console** — no seed, no code.
- **Network** — the seeds appear only in the `list_two_factor_entries` response
  body. No seed in any URL, query string or header.
- **Analytics** — every `analytics.track` call for this tool carries
  `tool_identifier: 'two-factor'` and no seed-shaped property. (The database
  guard `analytics_properties_are_safe_v2` independently rejects values matching
  `bearer|oauth|token=|authorization`, which is why the identifier avoids the
  word "token" entirely.)

---

## Gates before a PR

One at a time, in this order:

```bash
nice -n 15 npm run format:check
nice -n 15 npm run lint
nice -n 15 npm run typecheck
nice -n 15 npx vitest run tests/totp.test.ts tests/two-factor-sql.test.ts \
  tests/two-factor-ui.test.tsx tests/tool-registry.test.tsx \
  tests/launcher.test.tsx tests/route-matrix-contract.test.ts tests/i18n.test.ts \
  --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

Then the full suite in the background, once the focused ones are green.

**One release check worth doing explicitly**, because this feature touches the
tool registry:

```bash
nice -n 15 node scripts/verify-release.mjs
```

It must still pass **without** an agent release. If it fails complaining about
`stable.json`, something was added to `WEB_TOOL_REQUIREMENTS` that should not
have been — see D5 in [`research.md`](./research.md).
