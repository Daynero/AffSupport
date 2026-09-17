import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 022: a space's product catalog settings, and a video's catalog sheet as its
 * `product_catalog` companion — who may read and write what, and what the link function does
 * when two people create at once or one replaces the other's sheet.
 */

const OWNER = '22000000-0000-4000-8000-000000000001';
const VIEWER = '22000000-0000-4000-8000-000000000002';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

let harness: TeamTestDb;
let teamId: string;
let connectionId: string;
let fileSeq = 0;

const settings = {
  title: 'Polo shirt',
  description: 'Lightweight knit',
  price: 10,
  imageLink: 'https://drive.google.com/file/d/image/view?usp=sharing'
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    sourceLink: 'https://example.test/offer?sub=1',
    productCount: 100,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet/edit',
    videoLink: 'https://drive.google.com/file/d/video/view?usp=sharing',
    settingsSnapshot: settings,
    createdBy: OWNER,
    ...overrides
  };
}

async function material(name: string, category: string, mime: string): Promise<string> {
  fileSeq += 1;
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
     values ($1, $2, $3, 'root', $4, 'file', $5, $6)
     returning id`,
    [teamId, connectionId, `drive-${fileSeq}`, name, category, mime]
  );
  return rows[0]!.id;
}

const video = (name = 'clip.mp4') => material(name, 'video', 'video/mp4');
const sheet = (name = 'clip catalog') => material(name, 'other', SHEET_MIME);

async function link(
  videoId: string,
  sheetId: string,
  replaces: string | null = null,
  overrides: Record<string, unknown> = {}
) {
  const rows = await harness.root<{ result: Record<string, unknown> }>(
    'select public.service_link_product_catalog_companion($1, $2, $3, $4, $5) as result',
    [teamId, videoId, sheetId, replaces, JSON.stringify(record(overrides))]
  );
  return rows[0]!.result as {
    linked: boolean;
    reason?: string;
    existing?: Record<string, unknown> | null;
    discarded?: { materialId: string } | null;
    retired: Array<{ materialId: string }>;
    variant?: number;
  };
}

async function catalogs(videoId: string, as = OWNER) {
  return harness.asUser<{ id: string; variant: number; product_count: number }>(
    as,
    'select * from public.list_material_product_catalogs($1, $2)',
    [teamId, videoId]
  );
}

async function liveCatalog(videoId: string, as = OWNER) {
  return harness.asUser<{ id: string; sheet_url: string; product_count: number }>(
    as,
    'select * from public.get_material_product_catalog($1, $2)',
    [teamId, videoId]
  );
}

async function row(id: string) {
  const rows = await harness.root<{
    lifecycle: string;
    companion_of: string | null;
    companion_kind: string | null;
  }>('select lifecycle, companion_of, companion_kind from public.team_materials where id = $1', [
    id
  ]);
  return rows[0]!;
}

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@catalog.test', displayName: 'Owner' });
  await createUser(harness, { id: VIEWER, email: 'viewer@catalog.test', displayName: 'Viewer' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const team = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    ['Catalogs']
  );
  teamId = team[0]!.id;
  await harness.root(
    `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, 'viewer')`,
    [teamId, VIEWER]
  );
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-catalog', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
             gen_random_uuid(), $1)
     returning id`,
    [OWNER]
  );
  const connection = await harness.root<{ id: string }>(
    `insert into public.team_drive_connections
       (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at)
     values ($1, $2, 'root', 'Root', 'my_drive', 'connected', now())
     returning id`,
    [teamId, credential[0]!.id]
  );
  connectionId = connection[0]!.id;
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('space catalog settings', () => {
  it('starts unconfigured, is saved by a manager and read by a viewer', async () => {
    expect(
      await harness.asUser(OWNER, 'select * from public.get_team_product_catalog_settings($1)', [
        teamId
      ])
    ).toHaveLength(0);

    const saved = await harness.asUser<{ title: string; price: number }>(
      OWNER,
      'select * from public.set_team_product_catalog_settings($1, $2)',
      [teamId, JSON.stringify({ ...settings, title: '  Polo shirt  ' })]
    );
    expect(saved[0]).toMatchObject({ title: 'Polo shirt', price: 10 });

    const read = await harness.asUser<{ image_link: string }>(
      VIEWER,
      'select * from public.get_team_product_catalog_settings($1)',
      [teamId]
    );
    expect(read[0]!.image_link).toBe(settings.imageLink);
  }, 60_000);

  it('refuses a member who does not manage the space', async () => {
    await expect(
      harness.asUser(VIEWER, 'select * from public.set_team_product_catalog_settings($1, $2)', [
        teamId,
        JSON.stringify(settings)
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  }, 60_000);

  it.each([
    ['a title over 200 characters', { title: 'x'.repeat(201) }],
    ['a zero price', { price: 0 }],
    ['a price over 999999', { price: 1_000_000 }],
    ['a fractional price', { price: 10.5 }],
    ['a price given as text', { price: '10' }],
    ['an image link that is not http', { imageLink: 'ftp://example.test/a.png' }],
    ['an unknown key', { currency: 'EUR' }]
  ])(
    'refuses %s',
    async (_label, patch) => {
      await expect(
        harness.asUser(OWNER, 'select * from public.set_team_product_catalog_settings($1, $2)', [
          teamId,
          JSON.stringify({ ...settings, ...patch })
        ])
      ).rejects.toThrow(/INVALID_INPUT/);
    },
    60_000
  );

  it('keeps settings and the link function away from anon and from members calling the service', async () => {
    const grants = await harness.root<{ anon: boolean; authenticated: boolean }>(
      `select has_function_privilege('anon', 'public.service_link_product_catalog_companion(uuid, uuid, uuid, uuid, jsonb)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.service_link_product_catalog_companion(uuid, uuid, uuid, uuid, jsonb)', 'execute') as authenticated`
    );
    expect(grants[0]).toEqual({ anon: false, authenticated: false });
  }, 60_000);
});

describe('a video and its catalog', () => {
  it('links a sheet and reads it back for any member', async () => {
    const v = await video();
    const s = await sheet();
    expect((await link(v, s)).linked).toBe(true);
    expect(await row(s)).toMatchObject({ companion_of: v, companion_kind: 'product_catalog' });
    const read = await liveCatalog(v, VIEWER);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ id: s, product_count: 100 });
  }, 60_000);

  it('does not link what is not a video and a spreadsheet', async () => {
    const v = await video('b.mp4');
    const notSheet = await material('notes.txt', 'transcript', 'text/plain');
    expect(await link(v, notSheet)).toMatchObject({ linked: false, reason: 'NOT_ELIGIBLE' });
    const image = await material('pic.png', 'image', 'image/png');
    expect(await link(image, await sheet('pic catalog'))).toMatchObject({
      linked: false,
      reason: 'NOT_ELIGIBLE'
    });
  }, 60_000);

  it('holds several variations of one video at once, numbered in turn (024, US15)', async () => {
    const v = await video('race.mp4');
    const first = await sheet('race_v1_catalog');
    const second = await sheet('race_v2_catalog');
    expect(await link(v, first)).toMatchObject({ linked: true, variant: 1 });
    expect(
      await link(v, second, null, { sourceLink: 'https://example.test/offer?sub=2' })
    ).toMatchObject({ linked: true, variant: 2 });
    expect((await catalogs(v)).map(item => [item.id, item.variant])).toEqual([
      [first, 1],
      [second, 2]
    ]);
    // The newest stays what the released client reads.
    expect((await liveCatalog(v))[0]!.id).toBe(second);
  }, 60_000);

  it('never hands a removed variation’s number out again', async () => {
    const v = await video('numbers.mp4');
    await link(v, await sheet('numbers_v1_catalog'));
    const two = await sheet('numbers_v2_catalog');
    await link(v, two);
    await harness.root(
      `update public.team_materials set lifecycle = 'trashed', trashed_at = now() where id = $1`,
      [two]
    );
    expect(await link(v, await sheet('numbers_v3_catalog'))).toMatchObject({ variant: 3 });
    const next = await harness.root<{ value: number }>(
      'select public.service_next_product_catalog_variant($1, $2) as value',
      [teamId, v]
    );
    expect(Number(next[0]!.value)).toBe(4);
  }, 60_000);

  it('re-creates one variation: keeps its number and retires only its own sheet', async () => {
    const v = await video('again.mp4');
    const old = await sheet('again catalog');
    await link(v, old);
    const other = await sheet('again_v2_catalog');
    await link(v, other);
    const next = await sheet('again catalog (2)');
    const result = await link(v, next, old, { productCount: 5 });
    expect(result).toMatchObject({ linked: true, variant: 1 });
    expect((await catalogs(v)).map(item => item.id).sort()).toEqual([next, other].sort());
    expect(result.retired.map(entry => entry.materialId)).toEqual([old]);
    expect(await row(old)).toMatchObject({
      lifecycle: 'trashed',
      companion_of: null,
      companion_kind: null
    });
    expect((await catalogs(v)).find(item => item.id === next)).toMatchObject({ product_count: 5 });
  }, 60_000);

  it('treats a re-create naming a catalog someone already replaced as losing the race', async () => {
    const v = await video('stale.mp4');
    const a = await sheet('stale catalog');
    await link(v, a);
    const b = await sheet('stale catalog (2)');
    await link(v, b, a);
    const c = await sheet('stale catalog (3)');
    expect(await link(v, c, a)).toMatchObject({ linked: false, reason: 'EXISTS' });
    expect((await liveCatalog(v))[0]!.id).toBe(b);
  }, 60_000);

  it('brings a removed variation back as itself when it is restored', async () => {
    const v = await video('restore.mp4');
    const removed = await sheet('restore_v1_catalog');
    await link(v, removed);
    await harness.root(
      `update public.team_materials set lifecycle = 'trashed', trashed_at = now() where id = $1`,
      [removed]
    );
    expect(await catalogs(v)).toHaveLength(0);

    const made = await sheet('restore_v2_catalog');
    expect(await link(v, made)).toMatchObject({ linked: true, variant: 2 });
    await harness.root(
      `update public.team_materials set lifecycle = 'active', trashed_at = null where id = $1`,
      [removed]
    );
    expect((await catalogs(v)).map(item => item.variant)).toEqual([1, 2]);
  }, 60_000);

  it('lets one video hold a transcript and a catalog at once', async () => {
    const v = await video('both.mp4');
    await harness.root(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
          companion_of, companion_kind)
       values ($1, $2, 'both-txt', 'root', 'both.txt', 'file', 'transcript', 'text/plain', $3, 'transcript')`,
      [teamId, connectionId, v]
    );
    expect((await link(v, await sheet('both catalog'))).linked).toBe(true);
    const transcript = await harness.asUser(
      OWNER,
      'select * from public.get_material_transcript_companion($1, $2)',
      [teamId, v]
    );
    expect(transcript).toHaveLength(1);
    expect(await liveCatalog(v)).toHaveLength(1);
  }, 60_000);

  it('refuses a malformed record', async () => {
    const v = await video('bad.mp4');
    await expect(
      link(v, await sheet('bad catalog'), null, { productCount: 'many' })
    ).rejects.toThrow(/INVALID_INPUT/);
    await expect(
      link(v, await sheet('bad catalog 2'), null, { productCount: 401 })
    ).rejects.toThrow(/product_count_check/);
  }, 60_000);

  it('shows nothing to someone outside the space', async () => {
    const v = await video('private.mp4');
    await link(v, await sheet('private catalog'));
    const OUTSIDER = '22000000-0000-4000-8000-000000000009';
    await createUser(harness, { id: OUTSIDER, email: 'outsider@catalog.test' });
    expect(await liveCatalog(v, OUTSIDER)).toHaveLength(0);
  }, 60_000);
});
