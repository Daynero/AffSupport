import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';
import {
  RESTITCH_OWNER,
  RESTITCH_PROCESSOR,
  RESTITCH_STRANGER,
  RESTITCH_VIEWER,
  seedRestitchSpace,
  type RestitchSpace
} from './support/restitch-space';

/**
 * Feature 030: the server draws one picture per slot for a job. Uniform over distinct bytes,
 * never the excluded one, nothing for a slot that is off, and a named refusal when the pool
 * has nothing to give. The background path always draws the space's pool with the owner's
 * settings, whoever asks.
 */

let harness: TeamTestDb;
let space: RestitchSpace;

interface Draw {
  sourceMode: string;
  pool: { start: string; end: string };
  screens: Array<{
    slot: string;
    materialId: string;
    checksum: string;
    mimeType: string;
    fileName: string;
  }>;
}

async function draw(as = RESTITCH_OWNER, exclude: string[] = []): Promise<Draw> {
  const rows = await harness.asUser<{ draw: Draw }>(
    as,
    'select public.draw_restitch_screens($1, $2::uuid[]) as draw',
    [space.teamId, exclude]
  );
  return rows[0]!.draw;
}

async function serviceDraw(actor: string, exclude: string[] = []): Promise<Draw> {
  const rows = await harness.root<{ draw: Draw }>(
    'select public.service_draw_restitch_screens($1, $2, $3::uuid[]) as draw',
    [space.teamId, actor, exclude]
  );
  return rows[0]!.draw;
}

async function saveDefaults(as: string, defaults: Record<string, unknown>, member = false) {
  await harness.asUser(
    as,
    `select public.${member ? 'set_member_restitch_defaults' : 'set_restitch_defaults'}($1, $2::jsonb)`,
    [space.teamId, JSON.stringify({ operation: 'restitch', sourceMode: 'drive', ...defaults })]
  );
}

async function setPool(
  slot: 'start' | 'end',
  items: unknown[],
  as = RESTITCH_OWNER,
  member = false
) {
  await harness.asUser(
    as,
    `select public.${member ? 'set_member_restitch_sources' : 'set_restitch_sources'}($1, $2, $3::jsonb)`,
    [space.teamId, slot, JSON.stringify(items)]
  );
}

beforeAll(async () => {
  harness = await createTeamTestDb();
  space = await seedRestitchSpace(harness);
  await setPool('start', [{ materialId: space.folders.fixtures }]);
  await setPool('end', [{ materialId: space.images.loose }]);
  await saveDefaults(RESTITCH_OWNER, {});
}, 90_000);

afterAll(async () => {
  await harness?.close();
});

describe('one picture per slot', () => {
  it('returns one screen per enabled slot with what the agent needs', async () => {
    const result = await draw();
    expect(result.sourceMode).toBe('drive');
    expect(result.pool).toEqual({ start: 'ready', end: 'ready' });
    expect(result.screens.map(screen => screen.slot)).toEqual(['start', 'end']);
    expect(result.screens[1]).toMatchObject({
      materialId: space.images.loose,
      mimeType: 'image/png',
      fileName: 'loose.png'
    });
    expect(result.screens[0]!.checksum).toMatch(/./);
  });

  it('needs only view, and refuses strangers', async () => {
    expect((await draw(RESTITCH_PROCESSOR)).screens).toHaveLength(2);
    await expect(draw(RESTITCH_STRANGER)).rejects.toThrow(/RESTITCH_FORBIDDEN/);
  });

  it('is uniform over distinct bytes, so twins do not weigh double', async () => {
    const counts = new Map<string, number>();
    for (let round = 0; round < 300; round += 1) {
      const picked = (await draw()).screens[0]!;
      counts.set(picked.checksum, (counts.get(picked.checksum) ?? 0) + 1);
    }
    // Five distinct pictures (png, jpg, webp, deep.jpg, the twins' shared bytes): each should
    // land well above a quarter of its fair share; the twins get one share, not two.
    expect(counts.size).toBe(5);
    for (const count of counts.values()) expect(count).toBeGreaterThan(300 / 5 / 4);
    expect(counts.get('same-bytes')!).toBeLessThan(300 / 2);
  });

  it('never returns the excluded picture', async () => {
    for (let round = 0; round < 20; round += 1) {
      const result = await draw(RESTITCH_OWNER, [space.images.loose]);
      expect(result.screens.map(screen => screen.slot)).toEqual(['start']);
    }
  });

  it('skips a slot that is switched off, and draws nothing for unstitch', async () => {
    await saveDefaults(RESTITCH_OWNER, { endEnabled: false });
    expect((await draw()).screens.map(screen => screen.slot)).toEqual(['start']);
    await saveDefaults(RESTITCH_OWNER, { operation: 'unstitch' });
    expect((await draw()).screens).toEqual([]);
    await saveDefaults(RESTITCH_OWNER, {});
  });

  it('refuses by name when every enabled slot is empty', async () => {
    await setPool('start', []);
    await setPool('end', []);
    await expect(draw()).rejects.toThrow(/RESTITCH_POOL_EMPTY/);
    await setPool('start', [{ materialId: space.folders.fixtures }]);
    await setPool('end', [{ materialId: space.images.loose }]);
  });

  it('tells a legacy space to go the old way', async () => {
    await harness.root(
      "update public.team_restitch_defaults set source_mode = 'legacy', start_image_ids = array[$2::uuid] where team_id = $1",
      [space.teamId, RESTITCH_OWNER]
    );
    expect(await draw()).toEqual({
      sourceMode: 'legacy',
      pool: { start: 'empty', end: 'empty' },
      screens: []
    });
    await harness.root(
      "update public.team_restitch_defaults set source_mode = 'drive', start_image_ids = '{}' where team_id = $1",
      [space.teamId]
    );
  });
});

describe('whose pool', () => {
  it('draws a member’s personal pool when they switched to it, the space pool otherwise', async () => {
    await setPool('start', [{ materialId: space.images.loose }], RESTITCH_VIEWER, true);
    await saveDefaults(RESTITCH_VIEWER, { endEnabled: false }, true);
    const personal = await draw(RESTITCH_VIEWER);
    expect(personal.screens).toEqual([
      expect.objectContaining({ slot: 'start', materialId: space.images.loose })
    ]);
    await harness.asUser(RESTITCH_VIEWER, 'select public.set_member_restitch_use_owner($1, true)', [
      space.teamId
    ]);
    const inherited = await draw(RESTITCH_VIEWER);
    expect(inherited.screens.map(screen => screen.slot)).toEqual(['start', 'end']);
    expect(inherited.screens[0]!.materialId).not.toBe(space.images.loose);
  });

  it('always draws the space pool with the owner’s settings for the background path', async () => {
    await harness.asUser(
      RESTITCH_VIEWER,
      'select public.set_member_restitch_use_owner($1, false)',
      [space.teamId]
    );
    const background = await serviceDraw(RESTITCH_VIEWER);
    expect(background.screens.map(screen => screen.slot)).toEqual(['start', 'end']);
    expect(background.screens[0]!.materialId).not.toBe(space.images.loose);
    expect(background.screens[1]!.materialId).toBe(space.images.loose);
  });

  it('answers a draw on a pool of five hundred in reasonable time', async () => {
    const big = await harness.root<{ id: string; driveId: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, mime_type)
       values ($1, $2, 'big-folder', 'root', 'big', 'folder', 'application/vnd.google-apps.folder')
       returning id, drive_file_id as "driveId"`,
      [space.teamId, space.connectionId]
    );
    await harness.root(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type, size_bytes, checksum)
       select $1, $2, 'big-' || n, 'big-folder', 'p' || n || '.jpg', 'file', 'image', 'image/jpeg', 10, 'big-' || n
       from generate_series(1, 600) as n`,
      [space.teamId, space.connectionId]
    );
    await setPool('start', [{ materialId: big[0]!.id }]);
    const started = performance.now();
    const listing = await harness.asUser<{
      listing: { pools: { start: { overLimit: boolean; eligibleCount: number } } };
    }>(RESTITCH_OWNER, "select public.list_restitch_sources($1, 'owner') as listing", [
      space.teamId
    ]);
    await serviceDraw(RESTITCH_OWNER);
    const elapsed = performance.now() - started;
    expect(listing[0]!.listing.pools.start).toMatchObject({ overLimit: true, eligibleCount: 500 });
    // A soft bound on PGlite; the point is a log line if it ever gets slow, not a flaky gate.
    if (elapsed > 300)
      console.warn(`[030] list+draw on 600 pictures took ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe('what the updater’s claim reads (030)', () => {
  it('gets the space’s settings as the owner sees them, whoever asks', async () => {
    await harness.asUser(
      RESTITCH_VIEWER,
      'select public.set_member_restitch_use_owner($1, false)',
      [space.teamId]
    );
    const rows = await harness.root<{ settings: { sourceMode: string; updatedBy: string } }>(
      'select public.service_get_space_restitch_defaults($1) as settings',
      [space.teamId]
    );
    expect(rows[0]!.settings).toMatchObject({ sourceMode: 'drive', updatedBy: RESTITCH_OWNER });
  });

  it('hands out a picture’s facts for a grant only to a member who may download', async () => {
    const facts = await harness.root<{ material_id: string; size_bytes: number; checksum: string }>(
      'select material_id, size_bytes, checksum from public.service_restitch_screen_context($1, $2, $3)',
      [space.teamId, RESTITCH_VIEWER, space.images.loose]
    );
    expect(facts[0]).toMatchObject({ material_id: space.images.loose, size_bytes: 100000 });
    await expect(
      harness.root('select * from public.service_restitch_screen_context($1, $2, $3)', [
        space.teamId,
        RESTITCH_PROCESSOR,
        space.images.loose
      ])
    ).rejects.toThrow(/RESTITCH_SOURCE_FORBIDDEN/);
    expect(
      await harness.root('select * from public.service_restitch_screen_context($1, $2, $3)', [
        space.teamId,
        RESTITCH_VIEWER,
        space.video
      ])
    ).toEqual([]);
    await expect(
      harness.root('select * from public.service_restitch_screen_context($1, $2, $3)', [
        space.teamId,
        RESTITCH_STRANGER,
        space.images.loose
      ])
    ).rejects.toThrow(/RESTITCH_SOURCE_FORBIDDEN/);
  });
});
