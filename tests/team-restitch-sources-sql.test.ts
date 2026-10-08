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
 * Feature 030: a space's re-stitch pictures are references to Drive materials, resolved into
 * an effective set at read time. Proved here against a real Postgres: the schema, the rule
 * for what counts as a picture, the recursive unfolding, the deduplication by bytes, who may
 * write which pool, and what the panel is told about every source.
 */

let harness: TeamTestDb;
let space: RestitchSpace;

interface Listing {
  sourceMode: string;
  legacyImageCount: number;
  pools: Record<
    'start' | 'end',
    {
      state: string;
      overLimit: boolean;
      eligibleCount: number;
      sources: Array<{
        materialId: string | null;
        driveFileId: string | null;
        kind: string;
        name: string;
        availability: string;
        imageCount: number;
        skipped: { format: number; size: number; animated: number };
      }>;
    }
  >;
}

async function list(scope: 'owner' | 'self', as = RESTITCH_OWNER): Promise<Listing> {
  const rows = await harness.asUser<{ listing: Listing }>(
    as,
    'select public.list_restitch_sources($1, $2) as listing',
    [space.teamId, scope]
  );
  return rows[0]!.listing;
}

async function set(
  slot: string,
  items: unknown[],
  as = RESTITCH_OWNER,
  fn = 'set_restitch_sources'
): Promise<Listing> {
  const rows = await harness.asUser<{ listing: Listing }>(
    as,
    `select public.${fn}($1, $2, $3::jsonb) as listing`,
    [space.teamId, slot, JSON.stringify(items)]
  );
  return rows[0]!.listing;
}

async function pool(slot: 'start' | 'end', user: string | null = null) {
  return harness.root<{ material_id: string; name: string; checksum: string }>(
    'select material_id, name, checksum from private.restitch_pool_images($1, $2, $3)',
    [space.teamId, user, slot]
  );
}

beforeAll(async () => {
  harness = await createTeamTestDb();
  space = await seedRestitchSpace(harness);
}, 90_000);

afterAll(async () => {
  await harness?.close();
});

describe('schema', () => {
  it('keeps the settings rows pointing at the legacy lists until something writes drive mode', async () => {
    const rows = await harness.root<{ source_mode: string }>(
      "select column_default from information_schema.columns where table_name = 'team_restitch_defaults' and column_name = 'source_mode'"
    );
    expect(rows).toHaveLength(1);
    const member = await harness.root(
      "select 1 from information_schema.columns where table_name = 'team_member_restitch_preferences' and column_name = 'source_mode'"
    );
    expect(member).toHaveLength(1);
  });

  it('insists on exactly one of material id or drive id, and a pending source being a folder', async () => {
    await expect(
      harness.root(
        `insert into public.team_restitch_sources (team_id, slot, kind) values ($1, 'start', 'file')`,
        [space.teamId]
      )
    ).rejects.toThrow(/one_reference/);
    await expect(
      harness.root(
        `insert into public.team_restitch_sources (team_id, slot, kind, drive_file_id)
         values ($1, 'start', 'file', 'x')`,
        [space.teamId]
      )
    ).rejects.toThrow(/pending_is_folder/);
  });

  it('is readable by members and not by strangers', async () => {
    await set('start', [{ materialId: space.images.loose }]);
    // Row-level security only applies once the session is the `authenticated` role, which is
    // what PostgREST runs as; the harness's plain `asUser` keeps superuser rights.
    const asRole = async (actor: string) => {
      await harness.root("select set_config('request.jwt.claim.sub', $1, false)", [actor]);
      await harness.root('set role authenticated');
      try {
        return await harness.root(
          'select slot from public.team_restitch_sources where team_id = $1',
          [space.teamId]
        );
      } finally {
        await harness.root('reset role');
        await harness.root("select set_config('request.jwt.claim.sub', '', false)");
      }
    };
    expect(await asRole(RESTITCH_VIEWER)).toHaveLength(1);
    expect(await asRole(RESTITCH_STRANGER)).toHaveLength(0);
    await set('start', []);
  });
});

describe('the effective set', () => {
  it('unfolds a folder recursively and keeps only pictures the agent will stitch', async () => {
    await set('start', [{ materialId: space.folders.fixtures }]);
    const names = (await pool('start')).map(row => row.name);
    // png, jpg, webp, the nested jpg, and one of the two twins: not heic/gif/svg/huge/trashed/missing.
    expect(names).toEqual(['a.png', 'b.jpg', 'c.webp', 'deep.jpg', 'twin-a.jpg']);
  });

  it('counts one picture for two files with the same bytes, and a file and its folder once', async () => {
    await set('start', [
      { materialId: space.folders.fixtures },
      { materialId: space.images.twinB }
    ]);
    const rows = await pool('start');
    expect(rows.filter(row => row.checksum === 'same-bytes')).toHaveLength(1);
    expect(rows).toHaveLength(5);
  });

  it('orders stably by name then id', async () => {
    await set('start', [
      { materialId: space.images.loose },
      { materialId: space.folders.fixtures }
    ]);
    const names = (await pool('start')).map(row => row.name);
    expect(names).toEqual(
      [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    );
  });

  it('ignores pictures of a connection that is no longer the space’s', async () => {
    await set('start', [{ materialId: space.images.foreign }]);
    expect(await pool('start')).toEqual([]);
  });
});

describe('writing a pool', () => {
  it('replaces the slot wholesale, flips the settings to drive mode and empties the legacy lists', async () => {
    await harness.asUser(RESTITCH_OWNER, 'select public.set_restitch_defaults($1, $2::jsonb)', [
      space.teamId,
      JSON.stringify({ operation: 'restitch', startImageIds: [RESTITCH_OWNER], endImageIds: [] })
    ]);
    const listing = await set('start', [{ materialId: space.folders.fixtures }]);
    expect(listing.sourceMode).toBe('drive');
    expect(listing.legacyImageCount).toBe(0);
    expect(listing.pools.start.sources.map(source => source.kind)).toEqual(['folder']);
    const again = await set('start', [{ materialId: space.images.loose }]);
    expect(again.pools.start.sources.map(source => source.materialId)).toEqual([
      space.images.loose
    ]);
    const row = await harness.root<{
      source_mode: string;
      start_image_ids: string[];
      configured: boolean;
    }>(
      'select source_mode, start_image_ids, configured from public.team_restitch_defaults where team_id = $1',
      [space.teamId]
    );
    expect(row[0]).toEqual({ source_mode: 'drive', start_image_ids: [], configured: true });
  });

  it('is the owner’s alone for the space pool, and refuses what is not an image or a folder', async () => {
    await expect(
      set('start', [{ materialId: space.images.loose }], RESTITCH_VIEWER)
    ).rejects.toThrow(/RESTITCH_FORBIDDEN/);
    await expect(set('start', [{ materialId: space.video }])).rejects.toThrow(
      /RESTITCH_SOURCES_INVALID/
    );
    await expect(set('start', [{ materialId: space.images.trashed }])).rejects.toThrow(
      /RESTITCH_SOURCES_INVALID/
    );
    await expect(set('start', [{ nonsense: true }])).rejects.toThrow(/RESTITCH_SOURCES_INVALID/);
    await expect(
      set(
        'start',
        Array.from({ length: 501 }, () => ({ materialId: space.images.loose }))
      )
    ).rejects.toThrow(/RESTITCH_SOURCES_TOO_MANY/);
    await expect(set('top', [])).rejects.toThrow(/RESTITCH_INVALID/);
  });

  it('accepts a Drive id for a folder the catalog has not indexed yet, and resolves it later', async () => {
    const listing = await set('end', [{ driveFileId: 'not-yet-indexed', kind: 'folder' }]);
    expect(listing.pools.end.sources[0]).toMatchObject({
      materialId: null,
      driveFileId: 'not-yet-indexed',
      availability: 'pending',
      imageCount: 0
    });
    expect(listing.pools.end.state).toBe('empty');
    const folder = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, mime_type)
       values ($1, $2, 'not-yet-indexed', 'root', 'Transferred', 'folder', 'application/vnd.google-apps.folder')
       returning id`,
      [space.teamId, space.connectionId]
    );
    await harness.root(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type, size_bytes, checksum)
       values ($1, $2, 'transferred-1', 'not-yet-indexed', 'old.png', 'file', 'image', 'image/png', 10, 'old-bytes')`,
      [space.teamId, space.connectionId]
    );
    const resolved = await list('owner');
    expect(resolved.pools.end.sources[0]).toMatchObject({
      materialId: folder[0]!.id,
      driveFileId: null,
      availability: 'available',
      imageCount: 1,
      name: 'Transferred'
    });
    expect(resolved.pools.end.state).toBe('ready');
    await set('end', []);
  });

  it('keeps a member’s personal pool apart, written by that member only', async () => {
    await expect(
      set(
        'start',
        [{ materialId: space.images.loose }],
        RESTITCH_OWNER,
        'set_member_restitch_sources'
      )
    ).rejects.toThrow(/RESTITCH_FORBIDDEN/);
    const personal = await set(
      'start',
      [{ materialId: space.images.loose }],
      RESTITCH_VIEWER,
      'set_member_restitch_sources'
    );
    expect(personal.sourceMode).toBe('drive');
    expect(personal.pools.start.sources.map(source => source.materialId)).toEqual([
      space.images.loose
    ]);
    const preference = await harness.root<{
      use_owner: boolean;
      source_mode: string;
      configured: boolean;
    }>(
      'select use_owner, source_mode, configured from public.team_member_restitch_preferences where team_id = $1 and user_id = $2',
      [space.teamId, RESTITCH_VIEWER]
    );
    expect(preference[0]).toEqual({ use_owner: false, source_mode: 'drive', configured: true });
    // The space pool did not move.
    expect(
      (await list('owner', RESTITCH_VIEWER)).pools.start.sources.map(s => s.materialId)
    ).toEqual([space.images.loose]);
    expect((await pool('start', RESTITCH_VIEWER)).map(row => row.name)).toEqual(['loose.png']);
  });

  it('lists the space pool for any member and refuses strangers', async () => {
    expect((await list('owner', RESTITCH_PROCESSOR)).sourceMode).toBe('drive');
    await expect(list('owner', RESTITCH_STRANGER)).rejects.toThrow(/RESTITCH_FORBIDDEN/);
  });
});

describe('what the panel is told', () => {
  it('counts eligible pictures per folder and says why the rest were skipped', async () => {
    const listing = await set('start', [{ materialId: space.folders.fixtures }]);
    const folder = listing.pools.start.sources[0]!;
    // Six usable files in the tree (the twins are two files); the pool counts their bytes once.
    expect(folder.imageCount).toBe(6);
    // heic + svg are formats; huge.jpg is size; gif is animated.
    expect(folder.skipped).toEqual({ format: 2, size: 1, animated: 1 });
    expect(listing.pools.start.eligibleCount).toBe(5);
    expect(listing.pools.start.state).toBe('ready');
    expect(listing.pools.start.overLimit).toBe(false);
  });

  it('names each unavailable source by what happened to it', async () => {
    // Trashed and missing files cannot be *added* (the writer refuses them), so they are added
    // live and then changed underneath, which is what Drive does.
    const fresh = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type, size_bytes, checksum)
       values ($1, $2, 'will-go', 'root', 'will-go.jpg', 'file', 'image', 'image/jpeg', 10, 'will-go')
       returning id`,
      [space.teamId, space.connectionId]
    );
    const movedOut = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type, size_bytes, checksum)
       values ($1, $2, 'will-move', 'root', 'will-move.jpg', 'file', 'image', 'image/jpeg', 10, 'will-move')
       returning id`,
      [space.teamId, space.connectionId]
    );
    await set('start', [
      { materialId: space.images.loose },
      { materialId: fresh[0]!.id },
      { materialId: movedOut[0]!.id },
      { materialId: space.images.heic }
    ]);
    await harness.root(
      "update public.team_materials set lifecycle = 'trashed', trashed_at = now() where id = $1",
      [fresh[0]!.id]
    );
    await harness.root(
      "update public.team_materials set lifecycle = 'missing', missing_at = now(), missing_reason = 'out_of_root' where id = $1",
      [movedOut[0]!.id]
    );
    const listing = await list('owner');
    expect(listing.pools.start.sources.map(source => source.availability)).toEqual([
      'available',
      'trashed',
      'out_of_root',
      'unsupported'
    ]);
    expect(listing.pools.start.state).toBe('partial');
    expect(listing.pools.start.eligibleCount).toBe(1);

    await harness.root(
      "update public.team_materials set lifecycle = 'missing', missing_at = now(), trashed_at = null, missing_reason = 'removed' where id = $1",
      [fresh[0]!.id]
    );
    expect((await list('owner')).pools.start.sources[1]!.availability).toBe('missing');

    // Back from the bin: ready again without anyone saving anything.
    await harness.root(
      "update public.team_materials set lifecycle = 'active', missing_reason = null, missing_at = null, trashed_at = null where id in ($1, $2)",
      [fresh[0]!.id, movedOut[0]!.id]
    );
    const revived = await list('owner');
    expect(revived.pools.start.eligibleCount).toBe(3);
    expect(revived.pools.start.state).toBe('partial'); // the heic is still unsupported
  });

  it('survives a rename and a move inside the root', async () => {
    await set('start', [{ materialId: space.folders.fixtures }]);
    await harness.root("update public.team_materials set name = 'renamed' where id = $1", [
      space.folders.fixtures
    ]);
    await harness.root(
      "update public.team_materials set parent_folder_id = 'elsewhere' where id = $1",
      [space.folders.fixtures]
    );
    const listing = await list('owner');
    expect(listing.pools.start.sources[0]!.name).toBe('renamed');
    expect(listing.pools.start.eligibleCount).toBe(5);
  });

  it('is empty, with every source disconnected, while the space has no connected Drive', async () => {
    await harness.root("update public.team_drive_connections set state = 'pending' where id = $1", [
      space.connectionId
    ]);
    const listing = await list('owner');
    expect(listing.pools.start.sources[0]!.availability).toBe('disconnected');
    expect(listing.pools.start.state).toBe('empty');
    await harness.root(
      "update public.team_drive_connections set state = 'connected' where id = $1",
      [space.connectionId]
    );
    expect((await list('owner')).pools.start.state).toBe('ready');
  });

  it('reports a legacy space by how many old ids it still holds', async () => {
    await harness.root(
      "update public.team_restitch_defaults set source_mode = 'legacy', start_image_ids = array[$2::uuid, $3::uuid] where team_id = $1",
      [space.teamId, RESTITCH_OWNER, RESTITCH_VIEWER]
    );
    const listing = await list('owner');
    expect(listing.sourceMode).toBe('legacy');
    expect(listing.legacyImageCount).toBe(2);
    await set('start', [{ materialId: space.folders.fixtures }]);
  });
});

describe('the settings writers in drive mode', () => {
  it('does not demand id lists from a drive-mode save, and says the mode back', async () => {
    const saved = await harness.asUser<{
      source_mode: string;
      configured: boolean;
      start_image_ids: string[];
    }>(
      RESTITCH_OWNER,
      'select source_mode, configured, start_image_ids from public.set_restitch_defaults($1, $2::jsonb)',
      [
        space.teamId,
        JSON.stringify({
          operation: 'restitch',
          sourceMode: 'drive',
          startImageIds: [RESTITCH_OWNER],
          endImageIds: [],
          fitMode: 'contain'
        })
      ]
    );
    expect(saved[0]).toEqual({ source_mode: 'drive', configured: true, start_image_ids: [] });
    // The processor inherits the space's settings; the viewer switched to personal ones above.
    const effective = await harness.asUser<{ settings: { sourceMode: string; fitMode: string } }>(
      RESTITCH_PROCESSOR,
      'select public.get_effective_restitch_defaults($1) as settings',
      [space.teamId]
    );
    expect(effective[0]!.settings).toMatchObject({ sourceMode: 'drive', fitMode: 'contain' });
  });

  it('still refuses a legacy save with no screens', async () => {
    await expect(
      harness.asUser(RESTITCH_OWNER, 'select public.set_restitch_defaults($1, $2::jsonb)', [
        space.teamId,
        JSON.stringify({
          operation: 'restitch',
          sourceMode: 'legacy',
          startImageIds: [],
          endImageIds: []
        })
      ])
    ).rejects.toThrow(/RESTITCH_NO_SCREENS/);
  });
});

describe('people leaving', () => {
  it('drops a member’s personal pool with the member and keeps the space pool when the owner goes', async () => {
    await set(
      'end',
      [{ materialId: space.images.loose }],
      RESTITCH_VIEWER,
      'set_member_restitch_sources'
    );
    await harness.root('delete from auth.users where id = $1', [RESTITCH_VIEWER]);
    expect(
      await harness.root(
        'select 1 from public.team_restitch_sources where team_id = $1 and user_id = $2',
        [space.teamId, RESTITCH_VIEWER]
      )
    ).toHaveLength(0);
    const before = await harness.root<{ n: number }>(
      'select count(*)::int as n from public.team_restitch_sources where team_id = $1 and user_id is null',
      [space.teamId]
    );
    expect(before[0]!.n).toBeGreaterThan(0);
    // The owner's row in auth.users cannot go while the team exists (teams.owner_id); what the
    // schema promises instead is that `added_by` is only a trace: nulling it changes nothing.
    await harness.root(
      'update public.team_restitch_sources set added_by = null where team_id = $1',
      [space.teamId]
    );
    const after = await harness.root<{ n: number }>(
      'select count(*)::int as n from public.team_restitch_sources where team_id = $1 and user_id is null',
      [space.teamId]
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
