import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setQueryExecutor, assertReadOnlySql } from '../scripts/analytics/db.js';
import {
  getCatalogImageDiagnosis,
  getCatalogImageAudit
} from '../scripts/analytics/catalog-images.js';
import { executeCommand, parseArgs } from '../scripts/analytics/cli.js';
import { CATALOG_IMAGE_ERROR_CODES } from '../packages/shared/src/team/catalog-images.js';
import { lookupCodeLocations } from '../scripts/analytics/code-map.js';

const USER = '45000000-0000-4000-8000-000000000001';
const TEAM = '45000000-0000-4000-8000-000000000002';
const JOB = '45000000-0000-4000-8000-000000000003';
const ENTRY = '45000000-0000-4000-8000-000000000004';
const PUBLICATION = '45000000-0000-4000-8000-000000000005';
const ASOF = '2099-01-01T00:00:00.000Z';
const period = { token: 'all', start: null, end: ASOF, as_of: ASOF, label: 'all' };
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  // Minimal real tables expose the migration's triggers/views rather than mocked SQL results.
  await db.exec(`
    create schema private; create schema auth;
    create role anon; create role authenticated; create role service_role; create role wishly_analytics_ro;
    create function private.task_cleanup_reference_tables() returns table(schema_name text,table_name text)
      language sql as $$ values ('private','catalog_image_diagnostic_metadata'),('private','catalog_image_daily') $$;
    create function private.guard_task_cleanup_reference() returns trigger language plpgsql as $$ begin return new; end $$;
    create table auth.users(id uuid primary key);
    create table public.team_catalog_image_imports(id uuid primary key,team_id uuid,actor_id uuid,source_kind text,state text,revision bigint,counts jsonb,created_at timestamptz default now(),source_deadline timestamptz default now()+interval '24 hours');
    create table private.catalog_image_import_entries(id uuid primary key,team_id uuid,job_id uuid,publication_id uuid,candidate_publication_id uuid,state text,error_code text,display_name text);
    create table private.catalog_image_publications(id uuid primary key,team_id uuid,state text,size_bytes bigint,classification jsonb,created_at timestamptz default now(),verified_at timestamptz);
    create table public.team_catalog_image_pool_entries(id uuid,team_id uuid,publication_id uuid,active boolean);
    create table private.catalog_image_uses(team_id uuid,publication_id uuid,catalog_attempt_id uuid,row_identity integer,state text,created_at timestamptz default now());
    create table private.catalog_image_purges(id uuid,publication_id uuid,scope_id uuid,reason text,state text,attempts integer,created_at timestamptz default now(),next_attempt_at timestamptz default now());
    create table private.catalog_image_journal(seq bigint generated always as identity primary key,team_id uuid,job_id uuid,entry_id uuid,publication_id uuid,stage text,code text,occurred_at timestamptz default now());
  `);
  await db.exec(
    readFileSync(resolve('supabase/migrations/20261206151000_catalog_r2_diagnostics.sql'), 'utf8')
  );
  await db.query('insert into auth.users(id) values($1)', [USER]);
  await db.query(
    `insert into public.team_catalog_image_imports(id,team_id,actor_id,source_kind,state,revision,counts)
    values($1,$2,$3,'local','collecting',1,'{}')`,
    [JOB, TEAM, USER]
  );
  await db.query(
    `insert into private.catalog_image_import_entries(id,team_id,job_id,state,display_name) values($1,$2,$3,'waiting_source','PRIVATE_IMAGE_NAME.png')`,
    [ENTRY, TEAM, JOB]
  );
  for (const state of [
    'staged',
    'validating',
    'deduplicating',
    'publishing',
    'verifying_origin',
    'verifying_public',
    'committing'
  ])
    await db.query('update private.catalog_image_import_entries set state=$1 where id=$2', [
      state,
      ENTRY
    ]);
  await db.query(
    `insert into private.catalog_image_publications(id,team_id,state,size_bytes,classification,verified_at) values($1,$2,'ready',12345,'{"mode":"unclassified"}',now())`,
    [PUBLICATION, TEAM]
  );
  await db.query(
    "update private.catalog_image_import_entries set state='ready',publication_id=$1 where id=$2",
    [PUBLICATION, ENTRY]
  );
});
afterEach(async () => {
  setQueryExecutor(null);
  await db.exec('reset role');
});
afterAll(async () => {
  await db.close();
});

const connect = () =>
  setQueryExecutor(async (sql, params) => {
    assertReadOnlySql(sql);
    return (await db.query<Record<string, unknown>>(sql, params)).rows;
  });

describe('catalog image producer → projection → read-only CLI', () => {
  it('explains pool removal from actual producer evidence while preserving the publication', async () => {
    const pool = '45000000-0000-4000-8000-000000000090';
    await db.query(
      'insert into public.team_catalog_image_pool_entries(id,team_id,publication_id,active) values($1,$2,$3,true)',
      [pool, TEAM, PUBLICATION]
    );
    await db.query('update public.team_catalog_image_pool_entries set active=false where id=$1', [
      pool
    ]);
    await db.exec('set role wishly_analytics_ro');
    connect();
    const result = await executeCommand(
      parseArgs(['catalog-images', PUBLICATION, '--period', 'all', '--as-of', ASOF, '--json'])
    );
    expect(result.data).toMatchObject({
      last_proven_stage: 'pool_removed',
      findings: expect.arrayContaining([
        expect.objectContaining({ kind: 'fact', code: 'POOL_REMOVED' })
      ])
    });
    expect(JSON.stringify(result.data)).toContain('pool_added');
    expect(JSON.stringify(result.data)).not.toMatch(/public_url|PRIVATE_IMAGE_NAME|sha256/u);
    const retained = await db.query<{ state: string }>(
      'select state from public.analytics_catalog_image_publications where id=$1',
      [PUBLICATION]
    );
    expect(retained.rows[0]?.state).toBe('ready');
  });
  it('reads a real trigger-produced chain without names, URLs, hashes or clipboard contents', async () => {
    await db.exec('set role wishly_analytics_ro');
    connect();
    const result = await executeCommand(
      parseArgs(['catalog-images', ENTRY, '--period', 'all', '--as-of', ASOF, '--json'])
    );
    expect(result.data).toMatchObject({
      supported: true,
      last_proven_stage: 'ready',
      terminal: { stage: 'ready' },
      coverage: { capture_enabled: true, missing_stages: [] },
      costs: { status: 'unsupported_by_producer' }
    });
    const text = JSON.stringify(result.data);
    expect(text).not.toContain('PRIVATE_IMAGE_NAME');
    expect(text).not.toContain('display_name');
    expect(text).not.toContain('public_url');
    expect(text).not.toContain('sha256');
    expect(text).toContain('random selection');
  });

  it('keeps per-user evidence scoped and does not invent results for a different subject', async () => {
    await db.exec('set role wishly_analytics_ro');
    connect();
    const mine = await getCatalogImageDiagnosis(null, period, { userId: USER });
    const other = await getCatalogImageDiagnosis(null, period, {
      userId: '45000000-0000-4000-8000-000000000099'
    });
    expect(mine.evidence.length).toBeGreaterThan(0);
    expect(other.evidence).toEqual([]);
    expect(other.terminal).toBeNull();
    expect(other.coverage.missing_stages).toContain('ready');
  });

  it('supports bounded cursor pages and rejects malformed cursor input before SQL', async () => {
    connect();
    const first = await getCatalogImageDiagnosis(ENTRY, period, { limit: 2 });
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).not.toBeNull();
    const second = await getCatalogImageDiagnosis(ENTRY, period, {
      limit: 2,
      cursor: first.next_cursor
    });
    expect(
      second.evidence.every(
        row => !first.evidence.some(previous => previous.evidence_id === row.evidence_id)
      )
    ).toBe(true);
    await expect(getCatalogImageDiagnosis(ENTRY, period, { cursor: '1;delete' })).rejects.toThrow(
      'Invalid evidence cursor'
    );
    await expect(getCatalogImageDiagnosis(ENTRY, period, { limit: NaN })).rejects.toThrow(
      'positive integer'
    );
  });

  it('marks capture disabled instead of declaring coverage from existing events alone', async () => {
    connect();
    expect((await getCatalogImageAudit(period)).missing).not.toContain(
      'catalog_image_capture_unverified'
    );
    expect((await getCatalogImageAudit(period)).missing).not.toContain(
      'catalog_image_complete_correlated_chain_unobserved'
    );
    expect((await getCatalogImageAudit(period)).missing).toContain(
      'catalog_image_before_installation_unobserved'
    );
    await db.exec(
      'alter table private.catalog_image_import_entries disable trigger catalog_image_entry_diagnostics'
    );
    try {
      expect((await getCatalogImageAudit(period)).missing).toContain(
        'catalog_image_capture_unverified'
      );
    } finally {
      await db.exec(
        'alter table private.catalog_image_import_entries enable trigger catalog_image_entry_diagnostics'
      );
    }
  });

  it('exposes unknown causes safely and preserves an explicit blind spot', async () => {
    await db.query(
      `insert into private.catalog_image_journal(team_id,job_id,entry_id,stage,code)
      values($1,$2,$3,'failed','secret=https://private.example/token')`,
      [TEAM, JOB, ENTRY]
    );
    connect();
    const data = await getCatalogImageDiagnosis(ENTRY, period);
    expect(data.findings[0]).toMatchObject({ kind: 'insufficient', code: 'UNKNOWN' });
    expect(JSON.stringify(data)).not.toContain('private.example');
    expect((await getCatalogImageAudit(period)).missing).toContain('catalog_image_unknown_code');
  });

  it('allows only the safe projections to the analytics role', async () => {
    await db.exec('set role wishly_analytics_ro');
    await expect(db.query('select * from private.catalog_image_import_entries')).rejects.toThrow(
      /permission denied/iu
    );
    await expect(
      db.query('update public.team_catalog_image_imports set revision=2')
    ).rejects.toThrow(/permission denied/iu);
    expect(
      (await db.query('select evidence_id from public.analytics_catalog_image_journal limit 1'))
        .rows
    ).toHaveLength(1);
  });

  it('reports an unavailable source instead of treating it as a zero', async () => {
    setQueryExecutor(async () => []);
    const data = await getCatalogImageDiagnosis(ENTRY, period);
    expect(data.supported).toBe(false);
    expect(data.evidence).toEqual([]);
    expect(data.blind_spots[0]).toContain('unavailable');
    expect(data.costs.status).toBe('unsupported_by_producer');
  });

  it('maps every closed cause to the implementation and UI', () => {
    for (const code of CATALOG_IMAGE_ERROR_CODES) {
      const entry = lookupCodeLocations(`catalog:image:${code}`);
      expect(entry?.matched).toBe(`catalog:image:${code}`);
      expect(entry?.files).toContain(
        code === 'IMAGE_CLIPBOARD_UNAVAILABLE'
          ? 'apps/web/src/team/product-catalog/catalogImagePrompt.ts'
          : 'supabase/functions/catalog-images/worker.ts'
      );
    }
  });
});
