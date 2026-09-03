# Phase 1 — Data Model: 2FA Notebook

Entities from the spec, expressed as the storage and the in-memory shapes that
carry them. The wire surface itself is in [`contracts/rpc.md`](./contracts/rpc.md).

---

## Storage

### `private.two_factor_entries`

One row per stored credential. It lives in the `private` schema — not `public` —
so no PostgREST route can reach it at all, and the RPCs in `public` are the only
door. RLS is enabled and no client-facing policy is created; `revoke all` on the
table, with no compensating grant to `authenticated`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` primary key, `default gen_random_uuid()` | Stable across an edit, so a row does not jump under the pointer. |
| `owner` | `uuid not null references auth.users(id) on delete cascade` | The only access dimension in this version. Deleting the account takes the notebook with it. |
| `name` | `text not null` | 1–120 characters after trimming. Not unique: duplicate names are explicitly allowed (spec edge case). |
| `vault_secret_id` | `uuid not null` | The `vault.secrets` row holding the seed. Never exposed to a client. |
| `created_at` | `timestamptz not null default clock_timestamp()` | |
| `updated_at` | `timestamptz not null default clock_timestamp()` | Touched on every edit; drives the stable ordering. |

**Indexes.** `(owner, created_at desc, id)` — the one access path is "this
person's notebook, in order", and including `id` makes the order total, which is
what FR-013 needs.

**Constraints.**

- `char_length(btrim(name)) between 1 and 120`
- `unique (owner, vault_secret_id)` — a defensive guard against two rows ever
  sharing one vault secret, which would make deletion ambiguous.

### The vault link

The seed is stored with `vault.create_secret(seed, 'soty-2fa-' ||
gen_random_uuid()::text, 'Soty 2FA notebook seed')`, mirroring the naming of
`wishly-drive-…` in the Drive credential store.

The invariant to hold in every function: **a row and its secret are created and
destroyed together.**

- Create wraps the insert in `exception when others then delete from
  vault.secrets where id = secret_id; raise;` — the pattern
  `private.store_google_drive_credential` already uses, so a failed insert
  cannot leave an orphaned secret.
- Update replaces the value in place with `vault.update_secret(...)`, keeping
  the same `vault_secret_id`, so the row's identity is untouched.
- Delete removes the row and then `vault.secrets` by id, in one transaction.

---

## Validation

Applied in two places on purpose: the browser validates so the person gets a
useful message before a round trip, and the RPC validates because it is the
boundary that actually has to hold (principle I).

**Name.** Trimmed. Rejected empty; rejected beyond 120 characters. The database
repeats both as a check constraint.

**Seed.** Accepted in either of two forms:

1. A bare Base32 seed — normalised by uppercasing, stripping ASCII whitespace
   and stripping `=` padding. Must then be non-empty, contain only `A–Z` and
   `2–7`, and decode to at least 10 bytes (an 80-bit key, the RFC 4226 floor).
2. An `otpauth://totp/...` URI — the `secret` parameter is extracted and run
   through the same normalisation; the label, if present, pre-fills the name
   when the name field is empty (FR-010).

The parser returns `{ ok: true; value: TwoFactorSeed } | { ok: false; error:
TwoFactorSeedError }`, never a throw and never a cast, where the error is one of
`EMPTY`, `NOT_BASE32`, `TOO_SHORT`, `URI_WITHOUT_SECRET`. Each maps to its own
i18n message.

The RPC re-checks length and alphabet server-side. It cannot decode Base32 in
SQL cheaply, and does not need to: the check that matters at the boundary is
that the stored value is a plausible seed of sane length, not that it is the
right seed.

---

## In-memory shapes

### `TwoFactorEntry` — one row on the page

```text
id           string   — the row's uuid
name         string   — as stored
seed         string   — the normalised Base32 seed, decrypted for its owner
createdAt    string   — ISO 8601
updatedAt    string   — ISO 8601
```

Produced by `mapEntry(row: unknown): TwoFactorEntry | null` in
`api/two-factor.ts`, in the same style as `mapMember`/`mapTeamContext` in
`api/team.ts`: every field type-checked, `null` on anything unexpected, and the
caller rejects the whole batch with `INVALID_RESPONSE` if any row maps to
`null`.

### `GeneratedCode` — transient, never stored

```text
entryId      string
digits       string   — six characters, leading zeros preserved
validUntil   number   — epoch ms at the end of the current 30-second step
```

Held in page state keyed by entry id, replaced on each press, and dropped when
`validUntil` passes so a stale code is never presented as current (FR-017). It
is never persisted, never sent anywhere, and never attached to an analytics
event.

### `ClockSkew` — one number, once per page open

```text
offsetMs     number   — server Date header minus local clock
warn         boolean  — |offsetMs| > 10_000
```

---

## Lifecycle

```text
                    add (name + seed)
    ∅  ──────────────────────────────────────▶  stored
                                                  │
                    edit (name and/or seed)       │
    stored  ◀─────────────────────────────────────┤
                                                  │
                    delete (confirmed)            │
    ∅  ◀──────────────────────────────────────────┘
```

There are no other states. An entry is not archived, not soft-deleted, not
versioned, and carries no usage history — deletion is permanent (FR-012), which
is also what keeps a stale seed from lingering in a backup of a "deleted" row.

**Ordering.** Newest first by `(created_at desc, id)`, computed server-side and
preserved by the client. An edit updates `updated_at` but not `created_at`, so a
renamed entry keeps its place in the list (FR-013).

---

## Relationships

```text
auth.users ──1:N──▶ private.two_factor_entries ──1:1──▶ vault.secrets
              on delete cascade                    deleted with the row
```

`owner` is the only relationship, and it is the whole access model in this
version. It is a plain column rather than an implied "the caller owns
everything" so that a later team-scoped feature can add a `team_id` beside it
without rewriting stored rows (spec assumption).
