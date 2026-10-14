import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 20261201100000 — the space search ranks the way a person expects, forgives an infix and a
 * typo in the name, can look below a folder, and says where each row matched.
 */

const OWNER = '28000000-0000-4000-8000-000000000001';

interface Row {
  id: string;
  name: string;
  matchedIn: string | null;
  snippet: string | null;
  [key: string]: unknown;
}
interface SearchResult {
  items: Row[];
  total: number;
  facets: Record<string, Array<{ value: string; count: number }>>;
}

async function setupTeam(harness: TeamTestDb, label: string) {
  await createUser(harness, { id: OWNER, email: `owner@${label}.test`, displayName: 'Owner' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const team = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    [label]
  );
  const teamId = team[0]!.id;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ($1, 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
             gen_random_uuid(), $2)
     returning id`,
    [`perm-${label}`, OWNER]
  );
  const connection = await harness.root<{ id: string }>(
    `insert into public.team_drive_connections
       (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at)
     values ($1, $2, 'root', 'Root', 'my_drive', 'connected', now())
     returning id`,
    [teamId, credential[0]!.id]
  );
  return { teamId, connectionId: connection[0]!.id };
}

interface MaterialInput {
  name: string;
  driveId?: string;
  parent?: string;
  kind?: 'file' | 'folder';
  category?: string | null;
  mime?: string;
  tags?: string[];
  offer?: string | null;
  geo?: string | null;
  note?: string | null;
  transcript?: string | null;
  modifiedAt?: string;
}

function materialFactory(harness: TeamTestDb, teamId: string, connectionId: string) {
  let counter = 0;
  return async (input: MaterialInput) => {
    counter += 1;
    const rows = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
          tags, offer, geo, note, transcript_text, modified_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::text[], '{}'::text[]), $10, $11, $12, $13,
               coalesce($14::timestamptz, now() - make_interval(mins => $15)))
       returning id`,
      [
        teamId,
        connectionId,
        input.driveId ?? `d-${counter}-${input.name}`,
        input.parent ?? 'root',
        input.name,
        input.kind ?? 'file',
        input.kind === 'folder' ? null : (input.category ?? 'other'),
        input.mime ??
          (input.kind === 'folder'
            ? 'application/vnd.google-apps.folder'
            : 'application/octet-stream'),
        input.tags ?? null,
        input.offer ?? null,
        input.geo ?? null,
        input.note ?? null,
        input.transcript ?? null,
        input.modifiedAt ?? null,
        counter
      ]
    );
    return rows[0]!.id;
  };
}

describe('smarter material search (pg_trgm loaded)', () => {
  let harness: TeamTestDb;
  let teamId: string;
  let add: ReturnType<typeof materialFactory>;

  async function search(
    query: string | null,
    extra: {
      filters?: Record<string, string[]>;
      parent?: string | null;
      kind?: string[] | null;
      recursive?: boolean;
      pageSize?: number;
    } = {}
  ): Promise<SearchResult> {
    const args = [
      teamId,
      query,
      JSON.stringify(extra.filters ?? {}),
      extra.pageSize ?? 100,
      extra.parent ?? null,
      extra.kind ?? null
    ];
    const recursive = extra.recursive === undefined ? '' : `, p_recursive => ${extra.recursive}`;
    const rows = await harness.asUser<{ result: SearchResult }>(
      OWNER,
      `select public.search_materials(
         p_team => $1, p_query => $2, p_filters => $3::jsonb, p_page => 1, p_page_size => $4,
         p_parent_folder_id => $5, p_kind => $6::text[]${recursive}) as result`,
      args
    );
    return rows[0]!.result;
  }
  const names = (result: SearchResult) => result.items.map(item => item.name);

  beforeAll(async () => {
    harness = await createTeamTestDb({ extensions: { pg_trgm } });
    const team = await setupTeam(harness, 'smart-search');
    teamId = team.teamId;
    add = materialFactory(harness, teamId, team.connectionId);

    // Ranking fixtures — the transcript row is the newest, so only ranking can put it last.
    await add({
      name: 'Horses.png',
      category: 'image',
      mime: 'image/png',
      modifiedAt: '2026-01-01T00:00:00Z'
    });
    await add({
      name: 'Horses_running_v2.mp4',
      category: 'video',
      mime: 'video/mp4',
      modifiedAt: '2026-01-02T00:00:00Z'
    });
    await add({
      name: 'wild horses herd.mov',
      category: 'video',
      mime: 'video/quicktime',
      modifiedAt: '2026-01-03T00:00:00Z'
    });
    await add({
      name: 'Seahorses.jpg',
      category: 'image',
      mime: 'image/jpeg',
      modifiedAt: '2026-01-04T00:00:00Z'
    });
    await add({
      name: 'interview.mp4',
      category: 'video',
      mime: 'video/mp4',
      transcript:
        'We talked for a long while about the weather and then about horses horses horses, the horses ' +
        'that run on the beach, horses everywhere, and nothing else at all for the rest of the day.',
      modifiedAt: '2026-06-01T00:00:00Z'
    });
    await add({
      name: 'brief.docx',
      category: 'other',
      note: 'Client asked for a calmer palette and a clear call to action around the zebra banner only.',
      modifiedAt: '2026-05-01T00:00:00Z'
    });
    await add({
      name: 'tagged.png',
      category: 'image',
      mime: 'image/png',
      tags: ['gallop'],
      geo: 'UA'
    });
    await add({ name: 'Креатив_весна.mp4', category: 'video', mime: 'video/mp4', offer: 'Весна' });
    await add({ name: 'summer sale banner.png', category: 'image', mime: 'image/png', geo: 'DE' });
    await add({ name: 'promo_video_final.mp4', category: 'video', mime: 'video/mp4' });
    await add({ name: 'Clip31.mp4', category: 'video', mime: 'video/mp4' });
    await add({ name: 'Clip35.mp4', category: 'video', mime: 'video/mp4' });

    // Housekeeping files that the list hides.
    await add({ name: '.DS_Store', category: 'other' });
    await add({ name: 'Thumbs.db', category: 'other' });

    // Folders: A > B > C, a stallion file in each level.
    await add({ name: 'Archive A', kind: 'folder', driveId: 'fold-a' });
    await add({ name: 'Archive B', kind: 'folder', driveId: 'fold-b', parent: 'fold-a' });
    await add({ name: 'Archive C', kind: 'folder', driveId: 'fold-c', parent: 'fold-b' });
    await add({ name: 'stallion-top.png', parent: 'fold-a', category: 'image', mime: 'image/png' });
    await add({ name: 'stallion-mid.png', parent: 'fold-b', category: 'image', mime: 'image/png' });
    await add({
      name: 'stallion-deep.png',
      parent: 'fold-c',
      category: 'image',
      mime: 'image/png'
    });
    await add({ name: '.DS_Store', parent: 'fold-b', category: 'other', driveId: 'ds-b' });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('puts the exact name first and a transcript that repeats the word last', async () => {
    const result = await search('horses');
    const order = names(result);
    expect(order[0]).toBe('Horses.png');
    expect(order.indexOf('Horses_running_v2.mp4')).toBe(1);
    expect(order.indexOf('wild horses herd.mov')).toBe(2);
    expect(order.indexOf('Seahorses.jpg')).toBe(3);
    expect(order.at(-1)).toBe('interview.mp4');
  }, 60_000);

  it('matches an exact name with its extension and case-insensitively', async () => {
    expect(names(await search('HORSES.PNG'))[0]).toBe('Horses.png');
  }, 60_000);

  it('finds by prefix and by the start of any word of the name', async () => {
    expect(
      names(await search('hors'))
        .slice(0, 2)
        .sort()
    ).toEqual(['Horses.png', 'Horses_running_v2.mp4']);
    const herd = names(await search('herd'));
    expect(herd).toEqual(['wild horses herd.mov']);
    const running = names(await search('runn'));
    expect(running).toEqual(['Horses_running_v2.mp4']);
  }, 60_000);

  it('finds a name that merely contains the query', async () => {
    const result = await search('orse');
    expect(names(result)).toEqual(
      expect.arrayContaining(['Horses.png', 'Seahorses.jpg', 'wild horses herd.mov'])
    );
    expect(result.items.find(item => item.name === 'Seahorses.jpg')!.matchedIn).toBe('name');
  }, 60_000);

  it('requires every word of a multiword query', async () => {
    expect(names(await search('wild herd'))).toEqual(['wild horses herd.mov']);
    expect(names(await search('summer banner'))).toEqual(['summer sale banner.png']);
    expect(names(await search('summer zebra'))).toEqual([]);
  }, 60_000);

  it('handles Cyrillic names and metadata', async () => {
    expect(names(await search('креатив'))[0]).toBe('Креатив_весна.mp4');
    expect(names(await search('КРЕА'))[0]).toBe('Креатив_весна.mp4');
    const byOffer = await search('весна');
    expect(names(byOffer)).toContain('Креатив_весна.mp4');
  }, 60_000);

  it('searches below a folder only when asked', async () => {
    const direct = await search('stallion', { parent: 'fold-a' });
    expect(names(direct)).toEqual(['stallion-top.png']);
    const deep = await search('stallion', { parent: 'fold-a', recursive: true });
    expect(names(deep).sort()).toEqual([
      'stallion-deep.png',
      'stallion-mid.png',
      'stallion-top.png'
    ]);
    expect(deep.total).toBe(3);
    const fromMiddle = await search('stallion', { parent: 'fold-b', recursive: true });
    expect(names(fromMiddle).sort()).toEqual(['stallion-deep.png', 'stallion-mid.png']);
    const emptyQueryDeep = await search(null, { parent: 'fold-a', recursive: true });
    expect(names(emptyQueryDeep)).not.toContain('.DS_Store');
    expect(names(emptyQueryDeep)).toEqual(expect.arrayContaining(['Archive B', 'Archive C']));
  }, 60_000);

  it('explains a transcript match with a short plain snippet', async () => {
    const row = (await search('beach')).items.find(item => item.name === 'interview.mp4')!;
    expect(row.matchedIn).toBe('transcript');
    expect(row.snippet).toContain('beach');
    expect(row.snippet!.length).toBeLessThanOrEqual(160);
    expect(row.snippet).not.toMatch(/<b>|\s{2,}/);
  }, 60_000);

  it('explains a note match with a snippet, and a name match without one', async () => {
    const note = (await search('zebra')).items[0]!;
    expect(note.name).toBe('brief.docx');
    expect(note.matchedIn).toBe('note');
    expect(note.snippet).toContain('zebra');
    const name = (await search('brief')).items[0]!;
    expect(name.matchedIn).toBe('name');
    expect(name.snippet).toBeNull();
    const tag = (await search('gallop')).items[0]!;
    expect(tag.matchedIn).toBe('tags');
    const meta = (await search('DE')).items.find(item => item.name === 'summer sale banner.png')!;
    expect(meta.matchedIn).toBe('meta');
  }, 60_000);

  it('still applies filters and kinds', async () => {
    const images = await search('horses', { kind: ['image'] });
    expect(names(images).sort()).toEqual(['Horses.png', 'Seahorses.jpg']);
    const category = await search('horses', { filters: { category: ['video'] } });
    expect(names(category)).not.toContain('Horses.png');
    expect(names(category)).toContain('interview.mp4');
    const geo = await search(null, { filters: { geo: ['UA'] } });
    expect(names(geo)).toEqual(['tagged.png']);
    expect(category.facets.category).toEqual([{ value: 'video', count: category.total }]);
  }, 60_000);

  it('leaves housekeeping files out of rows and total', async () => {
    const all = await search(null);
    expect(names(all)).not.toContain('.DS_Store');
    expect(names(all)).not.toContain('Thumbs.db');
    expect(all.total).toBe(all.items.length);
    const typed = await search('ds_store');
    expect(typed.total).toBe(0);
    expect(typed.items).toEqual([]);
  }, 60_000);

  it('keeps newest-first for an empty query and no explanation', async () => {
    const all = await search('  ');
    const dates = all.items.map(item => Date.parse(String(item.modifiedAt)));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    expect(all.items.every(item => item.matchedIn === null && item.snippet === null)).toBe(true);
  }, 60_000);

  it('answers a call written for the old signature', async () => {
    const positional = await harness.asUser<{ result: SearchResult }>(
      OWNER,
      `select public.search_materials($1, 'horses', '{}'::jsonb, 1, 50) as result`,
      [teamId]
    );
    expect(positional[0]!.result.items[0]!.name).toBe('Horses.png');
    const named = await harness.asUser<{ result: SearchResult }>(
      OWNER,
      `select public.search_materials(p_team => $1, p_query => 'stallion', p_parent_folder_id => 'fold-a',
         p_kind => null) as result`,
      [teamId]
    );
    expect(named[0]!.result.items.map(item => item.name)).toEqual(['stallion-top.png']);
  }, 60_000);

  it('forgives a typo in the name', async () => {
    const result = await search('horsse');
    expect(names(result)).toContain('Horses.png');
    expect(result.items.find(item => item.name === 'Horses.png')!.matchedIn).toBe('name');
    expect(names(await search('vidoe'))).toContain('promo_video_final.mp4');
    expect(names(await search('кретив'))).toContain('Креатив_весна.mp4');
    // A numbered name is an identifier: Clip35 is not a typo of "clip31".
    expect(names(await search('clip31'))).toEqual(['Clip31.mp4']);
    // An unrelated word is not a typo of anything.
    expect(names(await search('zzzzqqq'))).toEqual([]);
  }, 60_000);

  it('rejects anything but a member', async () => {
    await expect(
      harness.asUser(null, `select public.search_materials($1, 'horses')`, [teamId])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  }, 60_000);
});

describe('smarter material search without pg_trgm', () => {
  let harness: TeamTestDb;
  let teamId: string;

  beforeAll(async () => {
    harness = await createTeamTestDb();
    const team = await setupTeam(harness, 'plain-search');
    teamId = team.teamId;
    const add = materialFactory(harness, teamId, team.connectionId);
    await add({ name: 'Horses.png', category: 'image', mime: 'image/png' });
    await add({ name: 'Seahorses.jpg', category: 'image', mime: 'image/jpeg' });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('keeps ranking and infix matching, and the fuzzy arm is off', async () => {
    const run = async (query: string) =>
      (
        await harness.asUser<{ result: SearchResult }>(
          OWNER,
          `select public.search_materials($1, $2) as result`,
          [teamId, query]
        )
      )[0]!.result.items.map(item => item.name);
    expect(await run('horses')).toEqual(['Horses.png', 'Seahorses.jpg']);
    expect(await run('orse')).toEqual(['Horses.png', 'Seahorses.jpg']);
    expect(await run('horsse')).toEqual([]);
  }, 60_000);
});
