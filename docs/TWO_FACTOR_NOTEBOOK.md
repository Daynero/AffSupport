# 2FA Notebook — operational notes

A personal list of two-factor keys: one line each, a copy button for the key, and
one press that computes the six-digit code and puts it on the clipboard. Feature
016; the reasoning behind every choice below, and what was rejected, is in
`specs/016-totp-notebook/research.md`.

Personal in this version — one notebook per person, no sharing. Team-space 2FA is
a later feature and is deliberately not half-built here.

## What it is made of

| Piece                                              | Where                                                        |
| -------------------------------------------------- | ------------------------------------------------------------ |
| Algorithm (Base32, HMAC-SHA-1, TOTP, `otpauth://`) | `packages/shared/src/totp.ts`                                |
| Table, vault link, four RPCs                       | `supabase/migrations/20260903100000_two_factor_notebook.sql` |
| Client wrappers and row mapping                    | `apps/web/src/api/two-factor.ts`                             |
| Page, context, row, form                           | `apps/web/src/two-factor/`                                   |
| Clipboard helper                                   | `apps/web/src/two-factor/clipboard.ts`                       |
| Clock check                                        | `apps/web/src/two-factor/clock-skew.ts`                      |
| Registry entry (`runtime: 'browser'`)              | `apps/web/src/lib/tool-registry.ts`                          |

## Three decisions worth knowing before you change anything

### The keys live in Vault, behind owner-scoped definer functions

`private.two_factor_entries` holds a name and a `vault_secret_id`. There is no
column with a key in it. The table is in `private`, so no PostgREST route
reaches it at all; RLS is on and **no policy exists**, because the four
`security definer` functions in `public` are meant to be the only door.

This is the shape `private.google_drive_credentials` already uses for refresh
tokens, with one deliberate difference: those functions are granted to
`service_role`, because only the server needs a refresh token. These are granted
to `authenticated`, because the owner's own browser is what needs the key — it
copies it, and it computes codes from it — and every statement carries
`where owner = auth.uid()`.

`update` and `delete` raise `ENTRY_NOT_FOUND` for a row owned by someone else,
the same code as a row that does not exist. That is not sloppiness: a
distinguishable "forbidden" would turn these functions into a way to ask whether
an id is real.

### The algorithm is hand-written, synchronous, and dependency-free

Not `crypto.subtle`, and not an npm package. Browsers gate a clipboard write on
user activation, and Safari refuses one issued after an intervening promise — so
a code computed asynchronously lands nowhere while the interface says "copied".
That bug passes casual local testing and fails for a real person on a Mac.

So `generateTotp` finishes inside the click handler, before `writeText` is
called. Everything downstream follows from that: the whole list is loaded once
with its keys (a row cannot fetch its key on press), and `packages/shared` keeps
its zero runtime dependencies. `tests/totp.test.ts` pins the implementation to
RFC 6238's own published vectors, including one past 2038 that catches a step
counter truncated to 32 bits.

### It is the first tool that never calls the local app

`WebTool` is a discriminated union on `runtime`. A `'browser'` tool skips the
capability check, `toolAvailable`, and the setup dialog, and its id is **not** in
`WEB_TOOL_REQUIREMENTS`.

That last part is the load-bearing one. `WEB_TOOL_REQUIREMENTS` is byte-compared
against the signed, published `stable.json` by `scripts/verify-release.mjs`, so a
key added there blocks `deploy:web` until an agent release publishes it. Correct
for a tool that needs the agent; exactly wrong for one that does not. If you add
another browser tool, extend `BrowserToolId` and leave that map alone.

Registering a tool also breaks three existing expectations on purpose — the two
`toEqual` arrays in `tests/launcher.test.tsx`, the route list in
`tests/tool-registry.test.tsx`, and the unswept-route assertion in
`tests/route-matrix-contract.test.ts`, which needs the new path added to `ROUTES`
in `scripts/verify-a11y.mjs`.

## What the interface deliberately does not do

- **It does not show a key.** The row shows a `2fa` marker; revealing is a
  separate per-row press and does not persist across a reload. Copying never
  needs the reveal.
- **It does not keep a stale code on screen.** The row drops a code when its step
  ends, because a code presented as current and then rejected gets blamed on the
  key.
- **It does not pretend a failed copy worked.** A refused `writeText` raises an
  error and puts the value on screen so it can be selected by hand.
- **It does not scan QR codes, import files, or keep history.** A notebook, not a
  password manager.

Codes are fixed at six digits on a thirty-second step. An `otpauth://` link
asking for other parameters is still accepted — the key is stored and the
defaults are used — because refusing it would leave the person unable to store
the key at all.

## Running and proving it

`specs/016-totp-notebook/quickstart.md` has the full pass. The short version:

```bash
nice -n 15 npx vitest run tests/totp.test.ts tests/two-factor-sql.test.ts \
  tests/two-factor-ui.test.tsx --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

Apply the migration to the **local** stack with `psql` into the container, never
`npx supabase db push` — the CLI here is linked to the remote project, so a push
would apply it to production from a developer's machine.

The rollback is destructive and irreversible: the vault secrets must be deleted
through the table's pointers _before_ the table is dropped, and everyone affected
has to re-enrol two-factor with the service that issued the key. Steps are in
`supabase/migrations/ROLLBACK.md`.

## Release

The tool ships behind the `twoFactorNotebook` acknowledgement flag in
`apps/web/src/lib/feature-flags.ts`. Flipping `protected` to `false` releases it.
No agent release is involved, and `node scripts/verify-release.mjs` must keep
passing without one.
