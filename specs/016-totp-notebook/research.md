# Phase 0 — Research: 2FA Notebook

No `NEEDS CLARIFICATION` markers were carried in from the spec; all three were
resolved before planning (see `checklists/requirements.md`). What follows are
the technical decisions the plan rests on, each with what was rejected and why.

---

## D1. Where the seeds live: Supabase Vault behind owner-scoped RPCs

**Decision.** `private.two_factor_entries` holds `id`, `owner`, `name`,
`vault_secret_id`, `created_at`, `updated_at`. The seed itself goes to
`vault.create_secret(...)`. Every client operation goes through a
`security definer` function in `public`, `set search_path = ''`, filtering on
`auth.uid()`, granted to `authenticated` and revoked from `public` and `anon`.
The table itself has RLS enabled with no client-facing policy at all, so the
functions are the only way in.

**Rationale.** This is not a new pattern: `private.google_drive_credentials`
already stores refresh tokens exactly this way
(`supabase/migrations/20260801094000_team_security_foundation.sql`), including
the `exception when others` block that deletes the orphaned vault secret if the
insert fails. Constitution principle III names this shape explicitly —
"client-facing access to sensitive tables goes through `security definer`
functions/views, never a broad policy."

The one deliberate difference from the Drive credentials: those functions are
granted to `service_role` only, because only the server ever needs a refresh
token. Here the owner's own browser needs the seed — to copy it (FR-014) and to
compute codes from it — so the functions are granted to `authenticated` and
carry the ownership check themselves.

**Alternatives considered.**

- *A plain `secret text` column with an RLS policy.* Fewer moving parts, and RLS
  would keep other users out. Rejected: a 2FA seed is standing account access,
  and principle III asks for structural protection rather than one policy
  between a database dump and every account. The Vault path already exists and
  costs one extra column.
- *End-to-end encryption under a user passphrase.* Strictly stronger — the
  server would hold only ciphertext. Rejected on the owner's behalf: a forgotten
  passphrase destroys every stored token with no recovery, and an unlock step at
  the start of every session is a heavy tax on a tool whose entire value
  proposition is one press. Recorded here because if the notebook ever holds
  other people's accounts, this trade should be revisited.
- *Never send the seed to the browser; compute codes in an Edge Function.*
  Rejected because it does not achieve anything: FR-014 requires the seed itself
  to be copyable, so the plaintext reaches the browser regardless. It would also
  put a network round trip inside the click handler — see D3.

---

## D2. The algorithm: pure, synchronous TypeScript in `packages/shared`

**Decision.** `packages/shared/src/totp.ts` implements Base32 decoding, SHA-1,
HMAC-SHA-1 and RFC 6238 dynamic truncation by hand, synchronously, with no
dependency, no DOM API and no Node built-in. It also parses `otpauth://` URIs.
Parameters are fixed at the ubiquitous defaults — SHA-1, 6 digits, a 30-second
step — per the spec's assumptions.

**Rationale.** Three constraints point the same way.

*Synchronous* — see D3; an `await` before the clipboard write is a real
cross-browser hazard.

*In `shared`* — it is domain logic, which principle I puts in
`@video-compressor/shared`, and it makes the RFC 6238 test vectors runnable as
a plain Node test with no jsdom and no browser shims.

*Dependency-free* — `packages/shared/package.json` has no runtime dependencies
today, and this package is compiled into the agent as well as the web app.
Adding a package there to avoid ~120 lines of fully specified, vector-verified
algorithm is a poor trade in a feature whose subject is account security.

**Alternatives considered.**

- *`crypto.subtle.importKey` + `sign('HMAC')`.* The obvious choice, and it is
  what `release-manifest.ts` uses for signature verification. Rejected here
  because it is promise-based; see D3. (Its use in `release-manifest.ts` is
  fine — nothing there is inside a click handler.)
- *An npm package (`otpauth`, `otplib`).* Battle-tested and less code to own.
  Rejected: it would be the first runtime dependency in `shared`, and the
  algorithm is small, frozen by RFC, and verifiable against the RFC's own test
  vectors — the exact case where owning the code is cheaper than owning the
  supply chain.

**Verification.** The RFC 6238 appendix-B vectors (the shared secret
`12345678901234567890`, at `59`, `1111111111`, `1234567890`, `2000000000` and
`20000000000` seconds) pin the implementation to the published values. Anything
that passes those produces the same digits as a phone authenticator.

---

## D3. The clipboard write stays inside the click

**Decision.** Pressing generate-and-copy computes the code synchronously and
calls `navigator.clipboard.writeText(code)` in the same handler turn, before any
`await`. The seeds are therefore already in memory when the button is pressed —
which is what D4 provides. A rejected write is caught and reported as a failure,
with the value revealed so it can be selected by hand (FR-018).

**Rationale.** Browsers gate clipboard writes on user activation. Safari is the
strictest: a write issued after an intervening promise resolution is refused,
and the user sees nothing on the clipboard while the interface says the code was
copied — precisely the "a failed copy never looks like a success" edge case,
except silent. Chrome and Firefox are more forgiving, which makes this the kind
of bug that passes local testing and fails for a user on a Mac.

**Alternatives considered.**

- *`new ClipboardItem({'text/plain': promise})`.* The standard escape hatch for
  async clipboard writes, and supported in Safari and Chrome. Rejected: Firefox
  does not accept a promise there, so it would need a second code path and a
  fallback anyway.
- *Fetch the seed on press, then write.* One round trip inside the gesture, the
  exact hazard above. Rejected.
- *Prefetch each seed on row hover.* Would preserve a seed-per-request model,
  but hover is not a reliable predictor on touch, and it trades one clean load
  for N speculative requests.

---

## D4. One load: the list RPC returns the decrypted seeds

**Decision.** `list_two_factor_entries()` returns every entry the caller owns,
including its decrypted seed, in one call. The page holds them in its context
for the session; search, code generation and copying all run against that.

**Rationale.** The seeds must reach the owner's browser anyway (FR-014 copies
them, FR-020 searches them, D3 needs them in memory before a click). Given that,
fetching them per-row would add round trips and a gesture hazard without
withholding anything: the same bytes end up in the same browser.

**What this does and does not protect.** Vault plus owner-scoped functions
defend the data at rest and against every non-owner path — another user, a
broad policy, an administrator browsing tables, a database dump. It does not
pretend to defend the owner's own session from the owner's own machine, which
is not a threat this feature can address and not one the spec claims. FR-022's
masking is about a shoulder or a shared screen, not about the process memory.

**Alternatives considered.**

- *List names only; `reveal_two_factor_secret(p_entry)` per row.* A smaller
  window in memory. Rejected for the reasons above, plus it would push search by
  seed (FR-020) into a debounced server round trip per keystroke, which SC-004's
  300 ms budget makes uncomfortable.

---

## D5. The tool registry learns about browser-only tools

**Decision.** `WebTool` gains `runtime: 'agent' | 'browser'`, and its `id` type
widens to `SotyToolId | BrowserToolId`. `HomePage.openTool` and
`ProtectedSoty.ToolRoute` consult `toolAvailable`, `capabilities` and the setup
dialog only when `runtime === 'agent'`. The notebook is the first
`runtime: 'browser'` tool. **Nothing is added to `WEB_TOOL_REQUIREMENTS`.**

**Rationale.** This is the finding that most shapes the plan. `SotyToolId` is
`keyof typeof WEB_TOOL_REQUIREMENTS` (`packages/shared/src/release.ts`), and the
comment above `stitcher` in that map spells out the consequence: the map is
byte-compared against the signed, published `stable.json` by
`verify-release.mjs`, so adding a key fails `deploy:web` until an agent release
publishes it. That gate is correct for agent tools and exactly wrong here — this
tool needs no agent contract, and gating a browser-only page on an agent release
would be a self-inflicted deployment block.

The current code offers no way to say "no agent needed": `capability: null`
still means "in the requirements map, without a capability" (transcription), and
both call sites still run `toolAvailable(tool.id)`, whose signature is
`(tool: SotyToolId) => boolean`. Without this change, opening the notebook while
the desktop app is closed would show a dialog offering to install software the
tool does not use — contradicting FR-002.

**Alternatives considered.**

- *Add `twoFactor: {}` to `WEB_TOOL_REQUIREMENTS`.* Rejected: an empty
  requirement still changes the signed-manifest comparison, so it blocks
  deployment for a tool with nothing to gate.
- *Keep the notebook off the registry and hand-route it.* Rejected: the registry
  is documented as the single source that registers a route, a home tile and a
  path classification in one step. Routing around it would fork that.

---

## D6. Telling the user their clock is wrong

**Decision.** When the tool opens it issues one `HEAD` request to its own
origin and compares the response's `Date` header with `Date.now()`. A
difference beyond ±10 seconds — a third of a step, enough to start producing
rejected codes — shows a warning line above the list. No time server is
contacted, and a failed or header-less response simply shows no warning.

**Rationale.** A wrong device clock is the single failure that makes a correct
implementation look broken: every code is rejected, and the natural conclusion
is that the stored seeds are wrong. One header from a request to an origin the
page already talks to is the cheapest possible detection, adds no external
origin (so the CSP output is unchanged) and degrades to silence.

**Alternatives considered.**

- *An NTP or time-API call.* A new external origin, a CSP entry, and a
  third-party dependency for a warning line. Rejected.
- *Read the `Date` header off the Supabase RPC response.* Free, but
  `supabase-js` does not surface response headers from `.rpc()` without
  reaching past its API. Rejected as more fragile than one explicit `HEAD`.
- *Say nothing and let codes fail.* Rejected — it is the spec's own edge case.
