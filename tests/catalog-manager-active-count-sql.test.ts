import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

// Cold PGlite/WASM startup shares this functional test's wall-clock budget.
it('counts live pending work and running verification, not schedules, unknown delivery or another team', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema auth; create schema private;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function private.can(uuid,text,uuid) returns boolean language sql as $$ select $1='10000000-0000-4000-8000-000000000001'::uuid and $3='20000000-0000-4000-8000-000000000001'::uuid $$;
      create function private.catalog_updater_state(uuid) returns jsonb language sql as $$ select '{"state":"running","catalogCount":4}'::jsonb $$;
      create table public.catalogs (id int, team_id uuid, active boolean);
      create function private.live_product_catalogs(uuid) returns table(catalog_material_id int) language sql as $$ select id from public.catalogs where team_id=$1 and active $$;
      create table public.team_catalog_updater_items(catalog_material_id int,team_id uuid,round_due_at timestamptz,reconciliation_required boolean);
      create table public.team_catalog_update_attempts(catalog_material_id int,team_id uuid,started_at timestamptz,attempt_id int,result text);
      insert into catalogs select n,'10000000-0000-4000-8000-000000000001',n<>5 from generate_series(1,5) n;
      insert into catalogs values(6,'10000000-0000-4000-8000-000000000002',true);
      insert into team_catalog_updater_items select id,team_id,case when id in(2,4) then null else now() end,id in(2,3) from catalogs;
      insert into team_catalog_update_attempts values
        (2,'10000000-0000-4000-8000-000000000001',now(),1,'running'),
        (3,'10000000-0000-4000-8000-000000000001',now(),2,'unknown');
    `);
    await db.exec(
      readFileSync('supabase/migrations/20261204180000_catalog_manager_active_count.sql', 'utf8')
    );
    const read = () =>
      db.query<{ state: { activeCount: number; catalogCount: number } }>(
        "select public.get_team_catalog_updater('10000000-0000-4000-8000-000000000001') as state"
      );
    await expect(read()).rejects.toThrow('PERMISSION_DENIED');
    await db.exec(
      "select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',false)"
    );
    expect((await read()).rows[0].state).toMatchObject({ activeCount: 2, catalogCount: 4 });
    await db.exec(
      "update team_catalog_updater_items set round_due_at=null where catalog_material_id=1; update team_catalog_update_attempts set result='unknown' where catalog_material_id=2"
    );
    expect((await read()).rows[0].state.activeCount).toBe(0);
    await db.exec(
      "select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',false)"
    );
    await expect(read()).rejects.toThrow('PERMISSION_DENIED');
  } finally {
    await db.close();
  }
}, 15_000);
