-- Feature 016 — the 2FA notebook: one person's two-factor seeds.
--
-- A seed is standing account access, so the shape here is the one
-- `private.google_drive_credentials` already uses for refresh tokens: the row
-- lives in `private` (no PostgREST route reaches that schema at all), the value
-- lives in the vault, and the row holds nothing but a pointer to it.
--
-- One deliberate difference from the Drive credentials. Those functions are
-- granted to `service_role`, because only the server ever needs a refresh
-- token. These are granted to `authenticated`, because the owner's own browser
-- is what needs the seed — it copies it, and it computes codes from it — and
-- they carry the ownership check themselves instead of relying on a policy.
--
-- The notebook is personal in this version. `owner` is a plain column rather
-- than an implied "the caller owns everything" so a later team scope can be
-- added beside it without rewriting stored rows.

create table private.two_factor_entries (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null,
  vault_secret_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint two_factor_entries_name_check
    check (char_length(btrim(name)) between 1 and 120),
  -- Defensive: two rows sharing one vault secret would make deletion ambiguous.
  constraint two_factor_entries_secret_unique unique (owner, vault_secret_id)
);

-- The one access path is "this person's notebook, in order". `id` is in the key
-- so the order is total and a row cannot swap places with another between
-- visits.
create index two_factor_entries_owner_idx
  on private.two_factor_entries (owner, created_at desc, id);

alter table private.two_factor_entries enable row level security;
revoke all on private.two_factor_entries from public, anon, authenticated;

-- No policy is created on purpose. A policy would be a second door, and the
-- functions below are meant to be the only one.

-- ---------------------------------------------------------------------------
-- Shared validation
-- ---------------------------------------------------------------------------

-- The seed is normalised in the browser before it gets here. This is the
-- boundary check, not the parser: it proves the stored value is a plausible key
-- of sane length, which is what the database can meaningfully know. Base32 is
-- not decoded in SQL, because whether the bytes mean anything is the
-- authenticator's question, not this table's.
create or replace function private.two_factor_secret_is_plausible(p_secret text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_secret is not null
     and p_secret ~ '^[A-Z2-7]{16,}$';
$$;

revoke all on function private.two_factor_secret_is_plausible(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reading the notebook
-- ---------------------------------------------------------------------------

-- The one function that hands out plaintext seeds, and only for the caller's
-- own rows. The seeds travel with the list rather than one at a time because
-- they have to reach this browser anyway — it copies them and computes codes
-- from them — and fetching them per row would put a network round trip inside
-- the click that writes to the clipboard.
create or replace function public.list_two_factor_entries()
returns table (
  id uuid,
  name text,
  secret text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  return query
  select
    entry.id,
    entry.name,
    secret.decrypted_secret,
    entry.created_at,
    entry.updated_at
  from private.two_factor_entries as entry
  join vault.decrypted_secrets as secret on secret.id = entry.vault_secret_id
  where entry.owner = auth.uid()
  order by entry.created_at desc, entry.id;
end;
$$;

revoke all on function public.list_two_factor_entries() from public, anon;
grant execute on function public.list_two_factor_entries() to authenticated;

-- ---------------------------------------------------------------------------
-- Adding an entry
-- ---------------------------------------------------------------------------

create or replace function public.create_two_factor_entry(p_name text, p_secret text)
returns table (
  id uuid,
  name text,
  secret text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_name text := btrim(coalesce(p_name, ''));
  secret_id uuid;
  created private.two_factor_entries;
begin
  if actor is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if char_length(clean_name) < 1 or char_length(clean_name) > 120 then
    raise exception 'INVALID_NAME' using errcode = '22023';
  end if;
  if not private.two_factor_secret_is_plausible(p_secret) then
    raise exception 'INVALID_SECRET' using errcode = '22023';
  end if;

  select vault.create_secret(
    p_secret,
    'soty-2fa-' || gen_random_uuid()::text,
    'Soty 2FA notebook seed'
  ) into secret_id;

  begin
    insert into private.two_factor_entries (owner, name, vault_secret_id)
    values (actor, clean_name, secret_id)
    returning * into created;
  exception
    when others then
      -- A row that never existed must not leave a secret behind. Same guard as
      -- private.store_google_drive_credential.
      delete from vault.secrets where vault.secrets.id = secret_id;
      raise;
  end;

  return query
  select created.id, created.name, p_secret, created.created_at, created.updated_at;
end;
$$;

revoke all on function public.create_two_factor_entry(text, text) from public, anon;
grant execute on function public.create_two_factor_entry(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Editing an entry
-- ---------------------------------------------------------------------------

-- `p_secret` null means "rename only". The vault secret is replaced in place, so
-- the row id and the vault_secret_id never change and the entry keeps both its
-- identity and its place in the list.
create or replace function public.update_two_factor_entry(
  p_entry uuid,
  p_name text,
  p_secret text
)
returns table (
  id uuid,
  name text,
  secret text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_name text := btrim(coalesce(p_name, ''));
  target private.two_factor_entries;
begin
  if actor is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if char_length(clean_name) < 1 or char_length(clean_name) > 120 then
    raise exception 'INVALID_NAME' using errcode = '22023';
  end if;
  if p_secret is not null and not private.two_factor_secret_is_plausible(p_secret) then
    raise exception 'INVALID_SECRET' using errcode = '22023';
  end if;

  select * into target
  from private.two_factor_entries as entry
  where entry.id = p_entry and entry.owner = actor;

  -- Deliberately the same code as a row that does not exist: a distinguishable
  -- "forbidden" would turn this function into a way to ask whether an id is real.
  if target.id is null then
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_secret is not null then
    perform vault.update_secret(target.vault_secret_id, p_secret);
  end if;

  update private.two_factor_entries as entry
  set name = clean_name,
      updated_at = clock_timestamp()
  where entry.id = target.id
  returning * into target;

  return query
  select
    target.id,
    target.name,
    secret.decrypted_secret,
    target.created_at,
    target.updated_at
  from vault.decrypted_secrets as secret
  where secret.id = target.vault_secret_id;
end;
$$;

revoke all on function public.update_two_factor_entry(uuid, text, text) from public, anon;
grant execute on function public.update_two_factor_entry(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Removing an entry
-- ---------------------------------------------------------------------------

-- Permanent, and it takes the vault secret with it. There is no archive and no
-- soft delete: a "deleted" seed lingering in a backup is the thing this avoids.
create or replace function public.delete_two_factor_entry(p_entry uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  secret_id uuid;
begin
  if actor is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  delete from private.two_factor_entries as entry
  where entry.id = p_entry and entry.owner = actor
  returning entry.vault_secret_id into secret_id;

  if secret_id is null then
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from vault.secrets where vault.secrets.id = secret_id;
end;
$$;

revoke all on function public.delete_two_factor_entry(uuid) from public, anon;
grant execute on function public.delete_two_factor_entry(uuid) to authenticated;
