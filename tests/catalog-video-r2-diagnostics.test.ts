import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setQueryExecutor } from '../scripts/analytics/db.js';
import { getCatalogVideoR2Diagnosis } from '../scripts/analytics/catalog-video-r2.js';
import { executeCommand, parseArgs } from '../scripts/analytics/cli.js';
import { CATALOG_VIDEO_R2_REASONS } from '../packages/shared/src/team/catalog-video-r2.js';
import { lookupCodeLocations } from '../scripts/analytics/code-map.js';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * AD-001..AD-007: the read-only CLI explains a copy from the immutable journal —
 * last proven stage, closed reasons with code locations, the proof limit, the
 * confirmed link kind, who changed the option — and names its blind spots.
 */
const OWNER = '50000000-0000-4000-8000-000000000801';
const WORKER = 'catalog-video-r2:diag-worker-0001';
const ASOF = '2099-01-01T00:00:00.000Z';
const period = { token: 'all', start: null, end: ASOF, as_of: ASOF, label: 'all' };
let db: TeamTestDb;
let team: string;
let catalog: string;
let video: string;
let copy: string;

const placeholders = (count: number) =>
  Array.from({ length: count }, (_, index) => '$' + String(index + 1)).join(',');
const rpc = async <T = unknown>(name: string, args: unknown[]) =>
  (await db.root<{ v: T }>(`select public.${name}(${placeholders(args.length)}) v`, args))[0]!.v;

beforeAll(async () => {
  db = await createTeamTestDb({ throughMigration: '20261207193000_catalog_video_r2.sql' });
  setQueryExecutor(async (sql, params) => db.root(sql, params));
  await createUser(db, { id: OWNER, email: 'video-r2-diag@example.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('R2 diag')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('video-r2-diag','diag@soty.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [OWNER]
    )
  )[0]!.id;
  const connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state) values($1,$2,'synthetic-root','Synthetic','my_drive','connected') returning id",
      [team, credential]
    )
  )[0]!.id;
  video = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type,size_bytes) values($1,$2,'file-diag','synthetic-root','PRIVATE NAME.mp4','file','video','video/mp4',8000000) returning id",
      [team, connection]
    )
  )[0]!.id;
  catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values($1,$2,'sheet-diag','synthetic-root','c','file','other','application/vnd.google-apps.spreadsheet') returning id",
      [team, connection]
    )
  )[0]!.id;
  await db.root(
    "insert into public.team_product_catalogs(material_id,team_id,video_material_id,source_link,product_count,sheet_url,video_link,settings_snapshot,created_by,variant) values($1,$2,$3,'https://example.test/source',3,'https://example.test/sheet','https://drive.google.com/file/d/x/view?usp=sharing','{}',$4,1)",
    [catalog, team, video, OWNER]
  );
  await db.root(
    "update private.catalog_video_r2_config set enabled=true,public_origin='https://videos.test',policy_confirmed_at=clock_timestamp()"
  );
  await rpc('service_catalog_video_r2_set_preference', [OWNER, catalog, true]);
  const planned = (await rpc('service_catalog_video_r2_resolve', [
    catalog,
    video,
    'strict-v1:diag',
    8_000_000,
    'video/mp4',
    null
  ])) as { copyId: string };
  copy = planned.copyId;
  const claim = (await rpc('service_catalog_video_r2_claim', [WORKER])) as Record<string, unknown>;
  const fence = claim.fence as number;
  await rpc('service_catalog_video_r2_begin_upload', [copy, WORKER, fence, 'upload-diag']);
  await rpc('service_catalog_video_r2_part', [
    copy,
    WORKER,
    fence,
    1,
    8_000_000,
    'a'.repeat(64),
    '"e1"',
    'readback',
    1500
  ]);
  await rpc('service_catalog_video_r2_verifying', [copy, WORKER, fence]);
  await rpc('service_catalog_video_r2_ready', [copy, WORKER, fence, false, 9000]);
  await rpc('service_catalog_video_r2_confirm_use', [
    catalog,
    'r2',
    JSON.stringify([{ sourceMaterialId: video, copyId: copy }])
  ]);
  // A second source version that the quota refuses: a closed reason without a copy row.
  await db.root('update private.catalog_video_r2_config set team_quota_bytes=1');
  await rpc('service_catalog_video_r2_resolve', [
    catalog,
    video,
    'strict-v1:diag-quota',
    8_000_000,
    'video/mp4',
    null
  ]);
}, 120_000);
afterAll(async () => {
  setQueryExecutor(null);
  await db?.close();
});

describe('catalog video R2 diagnostics', () => {
  it('reads the journey of a copy by team, catalog, source or copy id with the proof limit explicit', async () => {
    const byTeam = await getCatalogVideoR2Diagnosis(team, period);
    expect(byTeam.supported).toBe(true);
    expect(byTeam.evidence.length).toBeGreaterThanOrEqual(8);
    expect(byTeam.omitted_malformed).toBe(0);
    const stages = byTeam.evidence.map(row => row.stage).reverse();
    expect(stages.slice(0, 7)).toEqual([
      'configured',
      'planned',
      'uploading',
      'part_verified',
      'verifying',
      'ready',
      'confirmed'
    ]);
    expect(byTeam.coverage.missing_stages).toEqual([]);
    expect(byTeam.proof).toEqual({ full_hash_verified: false, part_verification: ['readback'] });
    expect(byTeam.blind_spots[0]).toMatch(/verified by parts and probes only/u);
    expect(byTeam.evidence.find(row => row.stage === 'confirmed')?.link_kind).toBe('r2');
    expect(byTeam.evidence.find(row => row.stage === 'part_verified')).toMatchObject({
      size_bucket: 'lt_16m',
      duration_bucket: 'lt_10s'
    });
    const byCopy = await getCatalogVideoR2Diagnosis(copy, period);
    expect(byCopy.evidence.every(row => row.copy_id === copy)).toBe(true);
    expect(byCopy.terminal).toMatchObject({ stage: 'ready', code: null });
    const byCatalog = await getCatalogVideoR2Diagnosis(catalog, period);
    expect(byCatalog.evidence.some(row => row.stage === 'configured')).toBe(true);
    expect(JSON.stringify(byTeam)).not.toContain('PRIVATE NAME');
    expect(JSON.stringify(byTeam)).not.toContain('videos.test');
  });

  it('turns a refused copy into a fact with code locations and reports current copy states', async () => {
    const diagnosis = await getCatalogVideoR2Diagnosis(team, {
      token: 'all',
      start: null,
      end: ASOF,
      label: 'all'
    });
    const quota = diagnosis.findings.find(item => item.code === 'VIDEO_R2_QUOTA_EXCEEDED');
    expect(quota).toMatchObject({
      kind: 'fact',
      evidence: expect.stringMatching(/^catalog-video-r2:\d+$/u)
    });
    expect(quota?.code_locations?.files).toContain(
      'supabase/migrations/20261207193000_catalog_video_r2.sql'
    );
    expect(diagnosis.observed_copies).toMatchObject({
      status: 'current_observation',
      ready: 1,
      retiring: 0,
      in_progress: 0,
      failed: 0,
      deleted: 0
    });
    expect(diagnosis.costs.status).toBe('estimate_only');
  });

  it('serves the CLI command with paging and refuses anything but ids', async () => {
    const page = await executeCommand(
      parseArgs([
        'catalog-video-r2',
        team,
        '--period',
        'all',
        '--as-of',
        ASOF,
        '--limit',
        '3',
        '--json'
      ])
    );
    const data = page.data as Awaited<ReturnType<typeof getCatalogVideoR2Diagnosis>>;
    expect(data.evidence).toHaveLength(3);
    expect(data.truncated).toBe(true);
    expect(data.next_cursor).toMatch(/^\d+$/u);
    const next = await executeCommand(
      parseArgs([
        'catalog-video-r2',
        team,
        '--period',
        'all',
        '--as-of',
        ASOF,
        '--limit',
        '3',
        '--cursor',
        data.next_cursor!,
        '--json'
      ])
    );
    const nextData = next.data as typeof data;
    expect(Number(nextData.evidence[0]!.evidence_id)).toBeLessThan(Number(data.next_cursor));
    await expect(getCatalogVideoR2Diagnosis('not-a-uuid', period)).rejects.toThrow(/UUID/u);
    await expect(getCatalogVideoR2Diagnosis(team, period, { cursor: 'x' })).rejects.toThrow(
      /cursor/u
    );
  });

  it('maps every closed reason to code before the first production copy', () => {
    for (const code of [...CATALOG_VIDEO_R2_REASONS, 'UNKNOWN']) {
      const match = lookupCodeLocations(`catalog:video_r2:${code}`);
      expect(match?.matched, code).toBe(`catalog:video_r2:${code}`);
      expect(match?.files.length, code).toBeGreaterThan(0);
    }
  });
});
