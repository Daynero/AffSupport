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
| Page, header, sorting, selection                   | `apps/web/src/two-factor/TwoFactorPage.tsx`                  |
| Row: reading, editing, adding, overflow menu       | `apps/web/src/two-factor/TwoFactorRow.tsx`                   |
| The code cluster, shared by row and quick bar      | `apps/web/src/two-factor/CodeReadout.tsx`                    |
| A code for a key that is not stored                | `apps/web/src/two-factor/QuickCode.tsx`                      |
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

## The shape of the interface

A table whose content is the codes. Every account shows its live six digits, all
of them turning over together under one countdown above the column, and the
digits are the button that copies them — press them and they are on the
clipboard. There is no separate copy button and no press needed to see a code:
the column that would otherwise be several hundred pixels of nothing between a
name and a button is the reason to look at the page.

Everything else is deliberately quiet. The add control is not the loud thing on
screen, because an account is added once and a code is taken twenty times a day.
The row's four actions — copy the key, show it, rename, delete — sit in the row
at 55% opacity and come to full contrast when the pointer is on it: present at a
glance, one click away, and not competing with the digits.
Editing happens in the row itself — and adding uses the same row, so there is one
editor rather than two that drift apart. Sorting, selection and a bulk delete sit
where a table puts them, and the checkboxes stay out of sight until the table is
touched.

The page is capped at 1180px rather than filling the display: two meaningful
columns do not improve with a 2560px monitor, they just move further apart until
the eye cannot carry a row across. The table's header is sticky below the app's
own topbar, because the countdown is one indicator for the whole page and a
wallet of forty accounts would otherwise scroll it out of sight along with any
sense of how long the codes on screen have left.

### Why the codes can be on screen and the keys cannot

A code lives thirty seconds and is single-use; a key is standing account access.
That is the whole of the reasoning. A key is shown only when its row is asked to
show it — and then it appears beside that row's code, where clicking it copies it
the same way clicking the digits does, down to the copy mark that fades in under
the pointer, the tick that replaces it, and the frame the hover draws. A key is
always shown whole: one longer than its line wraps rather than truncating,
because answering "show me the key" with two thirds of one is not an answer. The
code beside it never wraps — it cannot shrink, so the key is the part that gives
way. Two copyable values on one row should
not be copied by two different-looking gestures. It carries no `title`: a native tooltip
put the key on screen a second time, in a box that hung over the row below, which
is the opposite of what the rest of this design is for. Copying a key **without** showing it stays
its own action, because handing a key to a colleague mid-screen-share should not
flash it at the call. The codes blur after two minutes without interaction — any movement brings them
back, with no control to find and nothing to configure. See
`totp-clock.ts` for the one step counter and the one idle watch that serve every
row: N timers would be N re-renders a second and rows whose digits change a beat
apart.

Above the table, always, is the **quick-code bar**: paste a key that is not
stored — bare or as an `otpauth://` link — and take its code without saving
anything. It is the case a wallet otherwise handles badly, when somebody sends
you a key or you are half-way through enrolling an account. It sits behind no
toggle on purpose: a bar you have to open first is a bar nobody remembers exists
at the moment they need it.

## What the interface deliberately does not do

- **It does not show a key.** The key is not a column at all. Copying it and
  revealing it live in the row's overflow menu, because neither is a daily
  action, and a screen full of keys is a screen anyone behind you can
  photograph. Copying never needs the reveal.
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
