import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

const TEAM = '78000000-0000-4000-8000-000000000021';
const OTHER_TEAM = '78000000-0000-4000-8000-000000000022';
const GENERATED = '78000000-0000-4000-8000-000000000023';
const MANUAL = '78000000-0000-4000-8000-000000000024';
const SUCCEEDED = '78000000-0000-4000-8000-000000000025';
const FAILED = '78000000-0000-4000-8000-000000000026';
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create schema private;
    create table public.team_launch_revisions (
      id uuid, team_id uuid, revision_no integer, result_kind text,
      config jsonb, sources jsonb, baseline_revision_id uuid,
      generated_url text, sub_values jsonb, result_overrides jsonb,
      created_at timestamptz
    );
    create table public.team_launch_generations (
      id uuid, team_id uuid, revision_id uuid, state text, created_at timestamptz
    );
    create table public.team_launch_campaigns (
      revision_id uuid, ordinal integer, budget_usd integer,
      ad_start integer, ad_end integer, name text
    );
    create table public.team_launch_revision_catalogs (
      revision_id uuid, catalog_id uuid, material_id uuid, variant integer,
      name_snapshot text, sheet_url text, restitch_material_id uuid
    );
    insert into public.team_launch_revisions values
      ('${GENERATED}','${TEAM}',1,'generated','{}','{}',null,
       'https://example.invalid/result','{}','{}','2026-10-15T00:00:00Z'),
      ('${MANUAL}','${TEAM}',2,'manual','{}','{}','${GENERATED}',
       'https://example.invalid/result','{}','{}','2026-10-15T00:01:00Z');
    insert into public.team_launch_generations values
      ('${SUCCEEDED}','${TEAM}','${GENERATED}','succeeded','2026-10-15T00:00:00Z'),
      ('${FAILED}','${TEAM}','${GENERATED}','failed','2026-10-15T00:02:00Z'),
      ('${FAILED}','${OTHER_TEAM}','${GENERATED}','succeeded','2026-10-15T00:03:00Z');
  `);
  await db.exec(
    readFileSync(
      new URL(
        '../supabase/migrations/20261201193000_launch_result_visibility_correlation.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
}, 30_000);
afterAll(async () => {
  await db?.close();
});

it('projects only the successful producing generation for an authorized generated revision', async () => {
  const rows = await db.query<{ value: Record<string, unknown> }>(
    `select private.launch_revision_json($1::uuid,$2::uuid) as value`,
    [TEAM, GENERATED]
  );
  expect(rows.rows[0].value.generationId).toBe(SUCCEEDED);
  expect(rows.rows[0].value.id).toBe(GENERATED);
});

it('does not attribute a run to a manual revision or expose another team revision', async () => {
  const manual = await db.query<{ value: Record<string, unknown> }>(
    `select private.launch_revision_json($1::uuid,$2::uuid) as value`,
    [TEAM, MANUAL]
  );
  expect(manual.rows[0].value.generationId).toBeNull();
  const foreign = await db.query<{ value: Record<string, unknown> | null }>(
    `select private.launch_revision_json($1::uuid,$2::uuid) as value`,
    [OTHER_TEAM, GENERATED]
  );
  expect(foreign.rows[0].value).toBeNull();
});
