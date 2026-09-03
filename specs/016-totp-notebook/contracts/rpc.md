# Contract — Supabase RPCs

Four functions in `public`, each `language plpgsql`, `security definer`,
`set search_path = ''`, with fully-qualified names throughout. Each is
`revoke all … from public, anon` and `grant execute … to authenticated`.

Every function begins the same way, and this is the access model in full:

```sql
if auth.uid() is null then
  raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
end if;
```

…and every statement that touches `private.two_factor_entries` carries
`where owner = auth.uid()`. There is no other authorization path: the table has
RLS on with no client policy, so a caller who reaches past these functions
reaches nothing.

Errors are raised as stable machine codes, never sentences, so the client
branches on the code and the wording comes from i18n.

---

## `list_two_factor_entries()`

Returns the caller's whole notebook, newest first.

**Arguments:** none.

**Returns:** `setof record`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | |
| `name` | `text` | |
| `secret` | `text` | The decrypted seed, from `vault.decrypted_secrets`. |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |

Ordered by `created_at desc, id`.

**Errors:** `NOT_AUTHENTICATED`.

**Naming.** The column is `secret` — it is the vault's word, and the value is
what the vault stores. The client entity calls the same value `seed`, because in
the interface it is the thing a service issued you, not a thing the product
keeps. `mapEntry` in `api/two-factor.ts` is where `secret` becomes `seed`; below
this line, and throughout `data-model.md`, "seed" means the value and "secret"
means the column or the vault row.

**Note.** This is the one function that hands out plaintext seeds, and it does
so only for `auth.uid()`'s own rows. See D4 in `research.md` for why the seeds
travel with the list rather than one at a time.

---

## `create_two_factor_entry(p_name text, p_secret text)`

**Arguments**

| Name | Type | Validation |
| --- | --- | --- |
| `p_name` | `text` | Trimmed; 1–120 characters. |
| `p_secret` | `text` | Uppercased and stripped of whitespace/padding by the client; re-checked here for the `A–Z2–7` alphabet and a minimum of 16 characters (an 80-bit key). |

**Returns:** one row, the same columns as `list_two_factor_entries`, so the
client can insert the new entry without a refetch.

**Behaviour.** Creates the vault secret, then the row, inside one transaction. If
the insert fails for any reason, the vault secret is deleted before the error is
re-raised — no orphaned secrets (see `data-model.md`).

**Errors:** `NOT_AUTHENTICATED`, `INVALID_NAME` (`22023`), `INVALID_SECRET`
(`22023`).

---

## `update_two_factor_entry(p_entry uuid, p_name text, p_secret text)`

**Arguments**

| Name | Type | Validation |
| --- | --- | --- |
| `p_entry` | `uuid` | Must belong to `auth.uid()`. |
| `p_name` | `text` | As above. |
| `p_secret` | `text` | As above, **or `null`** to leave the stored seed untouched while renaming. |

**Returns:** the updated row, same columns as the list.

**Behaviour.** Renames the row and, when `p_secret` is non-null, replaces the
value in place via `vault.update_secret(vault_secret_id, p_secret)` — the
`vault_secret_id` and the row `id` never change, so the entry keeps its identity
and its position. `updated_at` is set to `clock_timestamp()`.

**Errors:** `NOT_AUTHENTICATED`, `ENTRY_NOT_FOUND` (`P0002` — raised identically
whether the row is absent or owned by someone else, so the function cannot be
used to probe for other people's ids), `INVALID_NAME`, `INVALID_SECRET`.

---

## `delete_two_factor_entry(p_entry uuid)`

**Arguments:** `p_entry uuid` — must belong to `auth.uid()`.

**Returns:** `void`.

**Behaviour.** Deletes the row and its `vault.secrets` entry in one transaction.
Permanent; there is no archive and no soft delete.

**Errors:** `NOT_AUTHENTICATED`, `ENTRY_NOT_FOUND`.

---

## Client wrapper

`apps/web/src/api/two-factor.ts` exposes one method per function through
`requireSupabaseClient().rpc(...)`, following `api/team.ts`: check `error`
first, then map rows with a total `mapEntry(row: unknown) => TwoFactorEntry |
null`, and throw a typed `TwoFactorApiError` carrying the machine code — plus
`INVALID_RESPONSE` when a row fails to map.

```text
listEntries():                          Promise<TwoFactorEntry[]>
createEntry(name, seed):                Promise<TwoFactorEntry>
updateEntry(id, name, seed | null):     Promise<TwoFactorEntry>
deleteEntry(id):                        Promise<void>
```

Supabase surfaces a raised exception's message as `error.message`; the wrapper
matches the known codes and falls back to `UNKNOWN` rather than showing a raw
database string to the user.

---

## Generated types

`apps/web/src/lib/database.types.ts` gets these four signatures added **by
hand**, with the same explanatory comment feature 015 used: the committed types
predate several unrelated columns in the local schema, so a wholesale
`npm run types:supabase` regeneration would drag that drift into this feature's
diff.
