-- Incident 2026-11-17: prod database at 97% CPU from 10:17 UTC.
--
-- heartbeat_library_job raised LEASE_EXPIRED with SQLSTATE 40001 (serialization_failure).
-- PostgREST treats 40001 as a transient conflict and re-runs the whole transaction itself,
-- with no limit and no pause. A lease that has expired stays expired, so every request that
-- hit it never returned: a few PostgREST connections re-ran the same RPC ~500 times a second,
-- the browser never heard back, and the gateway showed nothing because nothing finished.
--
-- Thirty-nine functions used 40001 for a business answer (LEASE_EXPIRED, STALE_RESULT,
-- LAUNCH_VERSION_CONFLICT, SOURCE_CHANGED, ...). None of them is a real serialization
-- failure; each is a loop waiting for its condition. They now raise PT409: PostgREST answers
-- HTTP 409 at once, and clients read the code from the message text exactly as before.
-- Nothing in the database catches 40001 from these functions.
--
-- The rewrite works from the live definitions, so whatever the latest migration made of each
-- function is kept; CREATE OR REPLACE keeps owner, grants and security attributes.
do $$
declare
  fn record;
  definition text;
  rewritten integer := 0;
begin
  for fn in
    select p.oid
    from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prokind = 'f'
      and p.prosrc ~ 'errcode\s*=\s*''40001'''
  loop
    definition := pg_get_functiondef(fn.oid);
    definition := regexp_replace(definition, 'errcode\s*=\s*''40001''', 'errcode = ''PT409''', 'g');
    execute definition;
    rewritten := rewritten + 1;
  end loop;
  raise notice 'business errors moved off 40001: % functions', rewritten;

  if exists (
    select 1 from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosrc ~ 'errcode\s*=\s*''40001'''
  ) then
    raise exception 'a function still raises 40001';
  end if;
end;
$$;
