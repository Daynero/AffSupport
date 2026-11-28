-- 057 T037: the catalog feed of an R2 space (FR-050, contracts/storage-api.md «Стрічка каталогу»).
--
-- A catalog in an R2 space has no Google sheet: its rows are a CSV file at
-- `catalog-videos[-beta].soty.pp.ua/feeds/{feed_id}.csv`, rewritten in place on every update.
-- `sheet_url` keeps that address, so every reader of the catalog record is unchanged. The feed
-- lives in the public catalog bucket, not in the space bucket, so it is not a `space_objects` row;
-- its bytes are counted in the space ledger under `catalogs` here, by the one function that
-- records a write. A Drive catalog never has a feed and none of this touches it.

alter table public.team_product_catalogs
  add column feed_id text,
  add column feed_revision bigint not null default 0,
  add column feed_written_at timestamptz,
  add column feed_bytes bigint not null default 0;
alter table public.team_product_catalogs
  add constraint team_product_catalogs_feed_id_check check (feed_id is null or feed_id ~ '^[0-9a-f]{32}$'),
  add constraint team_product_catalogs_feed_revision_check check (feed_revision >= 0),
  add constraint team_product_catalogs_feed_bytes_check check (
    feed_bytes >= 0 and (feed_id is not null or (feed_bytes = 0 and feed_revision = 0 and feed_written_at is null)));
create unique index team_product_catalogs_feed_idx on public.team_product_catalogs (feed_id)
  where feed_id is not null;

grant select (feed_revision, feed_written_at) on public.team_product_catalogs to authenticated;

-- Records one written feed: its bytes replace the previous ones in the ledger (`catalogs`), the
-- revision moves by one. `p_expected_revision` is the revision the writer started from, so two
-- writers racing cannot both count; the loser is told WRONG_STATE and its round retries.
create function public.service_record_catalog_feed(
  p_catalog uuid, p_feed_id text, p_bytes bigint, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.team_product_catalogs%rowtype;
  v_backend text;
begin
  if p_feed_id is null or p_feed_id !~ '^[0-9a-f]{32}$' or p_bytes is null or p_bytes < 1
     or p_bytes > 104857600 or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into c from public.team_product_catalogs where material_id = p_catalog for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select team.storage_backend into v_backend from public.teams team where team.id = c.team_id;
  if v_backend is distinct from 'r2' then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
  if (c.feed_id is not null and c.feed_id <> p_feed_id) or c.feed_revision <> p_expected_revision then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  perform private.space_usage_add(c.team_id, 'catalogs', p_bytes - c.feed_bytes,
    case when c.feed_revision = 0 then 1 else 0 end, 0);
  update public.team_product_catalogs set
    feed_id = p_feed_id,
    feed_bytes = p_bytes,
    feed_revision = c.feed_revision + 1,
    feed_written_at = now()
  where material_id = p_catalog;
  return jsonb_build_object('feedId', p_feed_id, 'feedRevision', (c.feed_revision + 1)::text,
    'feedBytes', p_bytes::text);
end;
$$;

-- A catalog row that goes takes its feed's bytes out of the ledger. Only an update of an
-- existing row: when the whole space goes, its ledger goes with it in the same cascade, and an
-- insert here would recreate a row for a space that no longer exists.
create function private.catalog_feed_released() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.space_storage_usage set
    bytes = greatest(bytes - old.feed_bytes, shared_bytes),
    objects = greatest(objects - 1, 0),
    revision = revision + 1
  where team_id = old.team_id and category = 'catalogs';
  return old;
end;
$$;
create trigger catalog_feed_released
after delete on public.team_product_catalogs
for each row when (old.feed_id is not null and old.feed_revision > 0)
execute function private.catalog_feed_released();

revoke all on function private.catalog_feed_released() from public, anon, authenticated;
revoke all on function public.service_record_catalog_feed(uuid, text, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.service_record_catalog_feed(uuid, text, bigint, bigint) to service_role;
