import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { materialKindOf } from '../packages/shared/src/team/index';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 011 (T014/T015): the two explorer reads and the kind rule, against a
 * real Postgres. Paging must be stable under inserts, folders sort first, the
 * total is the folder's, the limit is capped, and the SQL kind rule agrees
 * with the shared one on every mime/category combination.
 */

const OWNER = '30000000-0000-4000-8000-000000000001';
const STRANGER = '30000000-0000-4000-8000-000000000003';

let harness: TeamTestDb;
let teamId: string;
let connectionId: string;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@example.test', displayName: 'Owner' });
  await createUser(harness, {
    id: STRANGER,
    email: 'stranger@example.test',
    displayName: 'Stranger'
  });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const rows = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    ['Tree']
  );
  teamId = rows[0]!.id;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-tree', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
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
  await harness.root(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
     values
       ($1, $2, 'f-b', 'root', 'Beta', 'folder', null, 'application/vnd.google-apps.folder'),
       ($1, $2, 'f-a', 'root', 'alpha', 'folder', null, 'application/vnd.google-apps.folder'),
       ($1, $2, 'f-a-1', 'f-a', 'Nested', 'folder', null, 'application/vnd.google-apps.folder'),
       ($1, $2, 'v1', 'root', 'clip.mp4', 'file', 'video', 'video/mp4'),
       ($1, $2, 'i1', 'root', 'Banner.png', 'file', 'image', 'image/png'),
       ($1, $2, 'i2', 'root', 'banner-2.png', 'file', 'image', 'image/png'),
       ($1, $2, 'd1', 'root', 'Brief', 'file', 'other', 'application/vnd.google-apps.document'),
       ($1, $2, 'z1', 'root', 'zeta.txt', 'file', 'transcript', 'text/plain'),
       ($1, $2, 'n1', 'f-a', 'inside.png', 'file', 'image', 'image/png')`,
    [teamId, connectionId]
  );
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('list_team_folder_tree', () => {
  it('returns every folder with counts in one call, to members only', async () => {
    const tree = await harness.asUser<Record<string, unknown>>(
      OWNER,
      'select * from public.list_team_folder_tree($1)',
      [teamId]
    );
    expect(tree.map(node => node.name)).toEqual(['alpha', 'Beta', 'Nested']);
    const alpha = tree.find(node => node.drive_file_id === 'f-a')!;
    expect(alpha).toMatchObject({
      parent_folder_id: 'root',
      child_folder_count: 1,
      child_file_count: 1,
      thumbnail_ready_count: 0,
      indexed_at: null
    });
    expect(alpha.selection_id).toBeTruthy();
    await expect(
      harness.asUser(STRANGER, 'select * from public.list_team_folder_tree($1)', [teamId])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('refuses a tree above the published folder limit instead of truncating', async () => {
    // Ten thousand rows through the per-row triggers is slow in wasm Postgres
    // and proves nothing about the limit; the limit is what is under test.
    await harness.root('alter table public.team_materials disable trigger user');
    await harness.root(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, mime_type)
       select $1, $2, 'bulk-' || n, 'f-b', 'bulk ' || n, 'folder', 'application/vnd.google-apps.folder'
       from generate_series(1, 10001) as n`,
      [teamId, connectionId]
    );
    await expect(
      harness.asUser(OWNER, 'select * from public.list_team_folder_tree($1)', [teamId])
    ).rejects.toThrow(/TREE_TOO_LARGE/);
    await harness.root(`delete from public.team_materials where drive_file_id like 'bulk-%'`);
    await harness.root('alter table public.team_materials enable trigger user');
  }, 60_000);
});

describe('list_team_folder_page', () => {
  async function page(args: Record<string, unknown>) {
    const rows = await harness.asUser<{ page: Record<string, unknown> }>(
      OWNER,
      `select public.list_team_folder_page(
         $1,
         ($2::jsonb ->> 'parent'),
         case when $2::jsonb ? 'kinds'
              then array(select jsonb_array_elements_text($2::jsonb -> 'kinds')) end,
         ($2::jsonb ->> 'sortKey'),
         ($2::jsonb ->> 'id')::uuid,
         coalesce(($2::jsonb ->> 'limit')::integer, 100)
       ) as page`,
      [teamId, JSON.stringify(args)]
    );
    return rows[0]!.page as {
      rows: Array<Record<string, unknown>>;
      total: number;
      next: { sortKey: string; id: string } | null;
    };
  }

  it('pages the root folders-first with a stable cursor and a folder total', async () => {
    const first = await page({ limit: 3 });
    expect(first.total).toBe(7);
    // lower('banner-2.png') < lower('Banner.png'): '-' sorts before '.'.
    expect(first.rows.map(row => row.name)).toEqual(['alpha', 'Beta', 'banner-2.png']);
    expect(first.next).toEqual({ sortKey: first.rows[2]!.sortKey, id: first.rows[2]!.id });
    // An insert between pages must not shift the next page.
    await harness.root(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
       values ($1, $2, 'a0', 'root', 'aaa.png', 'file', 'image', 'image/png')`,
      [teamId, connectionId]
    );
    const second = await page({ limit: 3, sortKey: first.next!.sortKey, id: first.next!.id });
    expect(second.rows.map(row => row.name)).toEqual(['Banner.png', 'Brief', 'clip.mp4']);
    const third = await page({ limit: 3, sortKey: second.next!.sortKey, id: second.next!.id });
    expect(third.rows.map(row => row.name)).toEqual(['zeta.txt']);
    expect(third.next).toBeNull();
    await harness.root(`delete from public.team_materials where drive_file_id = 'a0'`);
  });

  it('shapes rows for the explorer: kinds, preview state, provider documents', async () => {
    const result = await page({});
    const byName = new Map(result.rows.map(row => [row.name as string, row]));
    expect(byName.get('Banner.png')).toMatchObject({
      kind: 'image',
      previewState: 'pending',
      thumbnailReady: false,
      parentFolderId: 'root',
      teamId
    });
    expect(byName.get('Brief')).toMatchObject({ kind: 'document', previewState: 'not_applicable' });
    expect(byName.get('alpha')).toMatchObject({ kind: 'folder' });
    expect(byName.get('clip.mp4')).toMatchObject({ kind: 'video' });
    expect(byName.get('Banner.png')!.landingRender).toBeUndefined();
  });

  it('keeps folders under a kind filter, walks into a folder, and caps the limit', async () => {
    const images = await page({ kinds: ['image'] });
    expect(images.rows.map(row => row.name)).toEqual([
      'alpha',
      'Beta',
      'banner-2.png',
      'Banner.png'
    ]);
    expect(images.total).toBe(4);
    const nested = await page({ parent: 'f-a' });
    expect(nested.rows.map(row => row.name)).toEqual(['Nested', 'inside.png']);
    await expect(page({ limit: 500 })).rejects.toThrow(/INVALID_INPUT/);
    await expect(page({ kinds: ['nonsense'] })).rejects.toThrow(/INVALID_INPUT/);
  });
});

describe('team_material_kind', () => {
  it('agrees with the shared materialKindOf on every combination', async () => {
    const storedKinds = ['file', 'folder', 'shortcut'];
    const mimes = [
      null,
      'image/png',
      'video/mp4; codecs=avc1',
      'application/vnd.google-apps.folder',
      'application/vnd.google-apps.shortcut',
      'application/vnd.google-apps.spreadsheet',
      'application/zip',
      'text/plain'
    ];
    const categories = [null, 'image', 'video', 'landing', 'archive', 'transcript', 'other'];
    const cases: Array<[string, string | null, string | null]> = [];
    for (const kind of storedKinds) {
      for (const mime of mimes)
        for (const category of categories) cases.push([kind, mime, category]);
    }
    const fromSql = await harness.root<{ kind: string }>(
      `select public.team_material_kind(item.kind, item.mime, item.category) as kind
       from jsonb_to_recordset($1::jsonb) as item(kind text, mime text, category text)`,
      [JSON.stringify(cases.map(([kind, mime, category]) => ({ kind, mime, category })))]
    );
    expect(fromSql.map(row => row.kind)).toEqual(
      cases.map(([storedKind, mimeType, category]) =>
        materialKindOf({ storedKind, mimeType, category })
      )
    );
  });
});
