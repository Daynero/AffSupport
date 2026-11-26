import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';
import { RESTITCH_OWNER, seedRestitchSpace, type RestitchSpace } from './support/restitch-space';

/**
 * A picture that cannot be a re-stitch screen is offered once, never again (2026-11-26).
 *
 * One space kept 135 macOS AppleDouble companions («._photo.png») beside its pictures; every
 * re-stitch drew them, the agent refused them, and the next video drew them again. Proved here
 * against a real Postgres: what counts as an operating system's own file, the three kinds of
 * evidence a pool reads, that a pool never loses a picture nothing is known about, and what the
 * settings panel is told about the files it cannot use.
 */

let harness: TeamTestDb;
let space: RestitchSpace;
let seq = 0;

const md5 = (seed: number) => seed.toString(16).padStart(32, '0');

interface Unusable {
  count: number;
  items: Array<{
    materialId: string;
    name: string;
    folderName: string;
    sizeBytes: number;
    reason: string;
  }>;
}
interface Listing {
  pools: Record<
    'start' | 'end',
    {
      state: string;
      eligibleCount: number;
      sources: Array<{ name: string; availability: string; imageCount: number }>;
      unusable: Unusable;
    }
  >;
}

async function folder(name: string): Promise<{ id: string; driveId: string }> {
  seq += 1;
  const driveId = `unusable-folder-${seq}`;
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, mime_type)
     values ($1, $2, $3, 'root', $4, 'folder', 'application/vnd.google-apps.folder')
     returning id`,
    [space.teamId, space.connectionId, driveId, name]
  );
  return { id: rows[0]!.id, driveId };
}

async function file(
  name: string,
  parent: string,
  options: { mime?: string; size?: number; checksum?: string; category?: string } = {}
): Promise<{ id: string; driveId: string; checksum: string }> {
  seq += 1;
  const driveId = `unusable-file-${seq}`;
  const checksum = options.checksum ?? md5(seq);
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
        size_bytes, checksum, drive_version)
     values ($1, $2, $3, $4, $5, 'file', $6, $7, $8, $9, '1')
     returning id`,
    [
      space.teamId,
      space.connectionId,
      driveId,
      parent,
      name,
      options.category ?? 'image',
      options.mime ?? 'image/png',
      options.size ?? 100_000,
      checksum
    ]
  );
  return { id: rows[0]!.id, driveId, checksum };
}

/** A row indexed before the rule existed: the trigger is off while it is written. */
async function grandfathered(name: string, parent: string, size = 400) {
  await harness.root(
    'alter table public.team_materials disable trigger team_materials_os_service_file'
  );
  try {
    return await file(name, parent, { size });
  } finally {
    await harness.root(
      'alter table public.team_materials enable trigger team_materials_os_service_file'
    );
  }
}

async function category(id: string): Promise<{ category: string; source: string }> {
  const rows = await harness.root<{ category: string; source: string }>(
    'select category, classification_source as source from public.team_materials where id = $1',
    [id]
  );
  return rows[0]!;
}

async function setPool(slot: 'start' | 'end', items: unknown[]): Promise<Listing> {
  const rows = await harness.asUser<{ listing: Listing }>(
    RESTITCH_OWNER,
    'select public.set_restitch_sources($1, $2, $3::jsonb) as listing',
    [space.teamId, slot, JSON.stringify(items)]
  );
  return rows[0]!.listing;
}

async function listing(): Promise<Listing> {
  const rows = await harness.asUser<{ listing: Listing }>(
    RESTITCH_OWNER,
    'select public.list_restitch_sources($1, $2) as listing',
    [space.teamId, 'owner']
  );
  return rows[0]!.listing;
}

/** The pictures a screen may be drawn from. */
async function poolNames(slot: 'start' | 'end'): Promise<string[]> {
  const rows = await harness.root<{ name: string }>(
    'select name from private.restitch_pool_usable_images($1, null, $2)',
    [space.teamId, slot]
  );
  return rows.map(row => row.name);
}

/** The pool as the space declared it: what a launch's settings version is computed from. */
async function declaredNames(slot: 'start' | 'end'): Promise<string[]> {
  const rows = await harness.root<{ name: string }>(
    'select name from private.restitch_pool_images($1, null, $2)',
    [space.teamId, slot]
  );
  return rows.map(row => row.name);
}

async function launchSettingsVersion(): Promise<string> {
  const rows = await harness.root<{ version: string }>(
    'select private.launch_restitch_settings_version($1, $2) as version',
    [space.teamId, RESTITCH_OWNER]
  );
  return rows[0]!.version;
}

async function snapshot(slot: 'start' | 'end') {
  const rows = await harness.root<{
    value: {
      candidates: Array<{ materialId: string }>;
      complete: boolean;
      eligibleObserved: number;
      ineligibleObserved: number;
      unknownObserved: number;
      unknownSourceCount: number;
    };
  }>('select private.restitch_selection_pool_snapshot($1, null, $2) as value', [
    space.teamId,
    slot
  ]);
  return rows[0]!.value;
}

async function probe(
  probes: Array<{
    driveFileId: string;
    checksum: string;
    width?: number | null;
    height?: number | null;
    settled?: boolean;
  }>
): Promise<number> {
  const rows = await harness.root<{ recorded: number }>(
    'select public.service_record_drive_image_probes($1, $2::jsonb) as recorded',
    [space.connectionId, JSON.stringify(probes)]
  );
  return rows[0]!.recorded;
}

async function verdict(checksum: string, value: 'usable' | 'unusable', mime = 'image/png') {
  await harness.root(
    `insert into private.restitch_screen_verdicts (team_id, checksum, mime_type, verdict, rejections)
     values ($1, $2, $3, $4, case when $4 = 'unusable' then 1 else 0 end)
     on conflict (team_id, checksum, mime_type) do update set verdict = excluded.verdict`,
    [space.teamId, checksum, mime, value]
  );
}

async function defect(target: { id: string }): Promise<string | null> {
  const rows = await harness.root<{ reason: string | null }>(
    `select private.restitch_screen_defect(team_id, connection_id, drive_file_id, name,
              mime_type, size_bytes, checksum) as reason
       from public.team_materials where id = $1`,
    [target.id]
  );
  return rows[0]!.reason;
}

beforeAll(async () => {
  harness = await createTeamTestDb();
  space = await seedRestitchSpace(harness);
}, 90_000);

afterAll(async () => {
  await harness?.close();
});

describe('files an operating system writes for itself', () => {
  it('knows them by name and nothing else by accident', async () => {
    const rows = await harness.root<{ name: string; service: boolean }>(
      `select name, private.os_service_file_name(name) as service
         from unnest($1::text[]) as name`,
      [
        [
          '._photo.png',
          '._',
          '.DS_Store',
          '.ds_store',
          'Thumbs.db',
          'THUMBS.DB',
          'desktop.ini',
          'photo.png',
          '.hidden.png',
          '_.photo.png',
          'my._photo.png',
          'thumbs.db.png',
          'desktop.ini.jpg'
        ]
      ]
    );
    expect(Object.fromEntries(rows.map(row => [row.name, row.service]))).toEqual({
      '._photo.png': true,
      '._': true,
      '.DS_Store': true,
      '.ds_store': true,
      'Thumbs.db': true,
      'THUMBS.DB': true,
      'desktop.ini': true,
      'photo.png': false,
      '.hidden.png': false,
      '_.photo.png': false,
      'my._photo.png': false,
      'thumbs.db.png': false,
      'desktop.ini.jpg': false
    });
    const none = await harness.root<{ service: boolean }>(
      'select private.os_service_file_name(null) as service'
    );
    expect(none[0]!.service).toBe(false);
  });

  it('indexes a new one as "other", whatever the scan called it', async () => {
    const companion = await file('._images (13) 1.png', 'root', { size: 180 });
    expect(await category(companion.id)).toEqual({ category: 'other', source: 'fallback' });
    const video = await file('._clip.mp4', 'root', { category: 'video', mime: 'video/mp4' });
    expect((await category(video.id)).category).toBe('other');
    const real = await file('images (13) 1.png', 'root');
    expect((await category(real.id)).category).toBe('image');
  });

  it('does not let a later scan make it a picture again', async () => {
    const companion = await file('._again.png', 'root', { size: 200 });
    // What catalog-sync writes on every pass: the name and the category it derived from MIME.
    await harness.root(
      "update public.team_materials set name = name, category = 'image', classification_source = 'mime' where id = $1",
      [companion.id]
    );
    expect(await category(companion.id)).toEqual({ category: 'other', source: 'fallback' });
  });

  it('moves a picture renamed into a service name, and leaves an ordinary rename alone', async () => {
    const picture = await file('before.png', 'root');
    await harness.root("update public.team_materials set name = '._before.png' where id = $1", [
      picture.id
    ]);
    expect((await category(picture.id)).category).toBe('other');
    const other = await file('plain.png', 'root');
    await harness.root("update public.team_materials set name = 'renamed.png' where id = $1", [
      other.id
    ]);
    expect((await category(other.id)).category).toBe('image');
  });

  it('keeps a row indexed before the rule as it is: a frozen candidate list still names it', async () => {
    const old = await grandfathered('._frozen.png', 'root');
    expect((await category(old.id)).category).toBe('image');
    await harness.root(
      "update public.team_materials set name = name, category = 'image' where id = $1",
      [old.id]
    );
    expect((await category(old.id)).category).toBe('image');
    // The trigger keeps the row and the declared pool keeps its shape; no screen is drawn from it.
    const ok = await harness.root<{ ok: boolean }>(
      `select private.restitch_image_ok(mime_type, size_bytes, name, checksum) as ok
         from public.team_materials where id = $1`,
      [old.id]
    );
    expect(ok[0]).toEqual({ ok: true });
    expect(await defect(old)).toBe('service_file');
  });
});

describe('what Drive read of a picture', () => {
  it('records dimensions, and silence only once Drive has had time', async () => {
    const real = await file('probe-real.png', 'root');
    const fresh = await file('probe-fresh.png', 'root', { size: 300 });
    const empty = await file('probe-empty.png', 'root', { size: 300 });
    expect(
      await probe([
        { driveFileId: real.driveId, checksum: real.checksum, width: 1080, height: 1920 },
        { driveFileId: fresh.driveId, checksum: fresh.checksum, settled: false },
        { driveFileId: empty.driveId, checksum: empty.checksum, settled: true }
      ])
    ).toBe(2);
    const rows = await harness.root<{ drive_file_id: string; width: number | null }>(
      'select drive_file_id, width from private.drive_image_probes where drive_file_id = any($1::text[]) order by drive_file_id',
      [[real.driveId, fresh.driveId, empty.driveId]]
    );
    expect(rows).toEqual(
      [
        { drive_file_id: real.driveId, width: 1080 },
        { drive_file_id: empty.driveId, width: null }
      ].sort((a, b) => a.drive_file_id.localeCompare(b.drive_file_id))
    );
    expect(await defect(real)).toBeNull();
    // Nothing is known about a file Drive has not read yet: it stays usable.
    expect(await defect(fresh)).toBeNull();
    expect(await defect(empty)).toBe('not_an_image');
  });

  it('never takes dimensions back, and starts over when the bytes change', async () => {
    const picture = await file('probe-keeps.png', 'root', { size: 500 });
    await probe([
      { driveFileId: picture.driveId, checksum: picture.checksum, width: 10, height: 20 }
    ]);
    // A later listing without the field (Drive is re-reading the file) changes nothing.
    expect(
      await probe([{ driveFileId: picture.driveId, checksum: picture.checksum, settled: true }])
    ).toBe(0);
    expect(await defect(picture)).toBeNull();
    // The same answer twice is not a write.
    expect(
      await probe([
        { driveFileId: picture.driveId, checksum: picture.checksum, width: 10, height: 20 }
      ])
    ).toBe(0);
    // New bytes under the same file: the old dimensions say nothing about them.
    const replaced = md5(900_001);
    await harness.root('update public.team_materials set checksum = $2 where id = $1', [
      picture.id,
      replaced
    ]);
    expect(await defect(picture)).toBeNull();
    expect(await probe([{ driveFileId: picture.driveId, checksum: replaced, settled: true }])).toBe(
      1
    );
    expect(await defect(picture)).toBe('not_an_image');
    // Drive read the picture a little later after all.
    expect(
      await probe([{ driveFileId: picture.driveId, checksum: replaced, width: 64, height: 64 }])
    ).toBe(1);
    expect(await defect(picture)).toBeNull();
  });

  it('treats missing dimensions alone as no verdict: only a file too small to be a picture is refused', async () => {
    const tiny = await file('probe-tiny.png', 'root', { size: 1023 });
    const small = await file('probe-small.png', 'root', { size: 1024 });
    await probe([
      { driveFileId: tiny.driveId, checksum: tiny.checksum, settled: true },
      { driveFileId: small.driveId, checksum: small.checksum, settled: true }
    ]);
    expect(await defect(tiny)).toBe('not_an_image');
    expect(await defect(small)).toBeNull();
  });

  it('ignores what is not a probe and refuses what is not a list', async () => {
    expect(
      await probe([
        { driveFileId: '', checksum: md5(1), width: 1, height: 1 },
        { driveFileId: 'no-checksum', checksum: 'md5-17', width: 1, height: 1 },
        { driveFileId: 'half', checksum: md5(2), width: 5, height: null, settled: false },
        { driveFileId: 'absurd', checksum: md5(3), width: 99_999_999, height: 1, settled: false }
      ])
    ).toBe(0);
    await expect(
      harness.root("select public.service_record_drive_image_probes($1, '{}'::jsonb)", [
        space.connectionId
      ])
    ).rejects.toThrow(/INVALID_INPUT/);
    const unknown = await harness.root<{ recorded: number }>(
      "select public.service_record_drive_image_probes('00000000-0000-4000-8000-00000000dead', $1::jsonb) as recorded",
      [JSON.stringify([{ driveFileId: 'x', checksum: md5(4), width: 1, height: 1 }])]
    );
    expect(unknown[0]!.recorded).toBe(0);
  });
});

describe('what an agent found', () => {
  it('is about the bytes: a copy is covered, a new version starts clean', async () => {
    const shared = md5(700_001);
    const first = await file('verdict-a.png', 'root', { checksum: shared });
    const copy = await file('verdict-copy.png', 'root', { checksum: shared });
    const sameBytesAsJpeg = await file('verdict-b.jpg', 'root', {
      checksum: shared,
      mime: 'image/jpeg'
    });
    await verdict(shared, 'unusable');
    expect(await defect(first)).toBe('undecodable');
    expect(await defect(copy)).toBe('undecodable');
    // The agent decodes by MIME type; a verdict about a PNG says nothing of a JPEG.
    expect(await defect(sameBytesAsJpeg)).toBeNull();
    await harness.root('update public.team_materials set checksum = $2 where id = $1', [
      first.id,
      md5(700_002)
    ]);
    expect(await defect(first)).toBeNull();
    expect(await defect(copy)).toBe('undecodable');
  });

  it('outranks what Drive did not see, and is itself outranked by the name', async () => {
    const decoded = await file('verdict-decoded.png', 'root', { size: 300 });
    await probe([{ driveFileId: decoded.driveId, checksum: decoded.checksum, settled: true }]);
    expect(await defect(decoded)).toBe('not_an_image');
    await verdict(decoded.checksum, 'usable');
    expect(await defect(decoded)).toBeNull();
    const companion = await grandfathered('._decoded.png', 'root');
    await verdict(companion.checksum, 'usable');
    expect(await defect(companion)).toBe('service_file');
  });

  it('does not reach another space', async () => {
    const mine = await file('verdict-mine.png', 'root');
    const other = await harness.asUser<{ id: string }>(
      RESTITCH_OWNER,
      'select id from public.create_team($1)',
      ['Another space']
    );
    expect(other[0]!.id).not.toBe(space.teamId);
    await harness.root(
      `insert into private.restitch_screen_verdicts (team_id, checksum, mime_type, verdict, rejections)
       values ($1, $2, 'image/png', 'unusable', 1)`,
      [other[0]!.id, mine.checksum]
    );
    expect(await defect(mine)).toBeNull();
  });
});

describe('a pool', () => {
  let pictures: { id: string; driveId: string };
  let good: Awaited<ReturnType<typeof file>>;
  let unknown: Awaited<ReturnType<typeof file>>;
  let companion: Awaited<ReturnType<typeof file>>;
  let reclassified: Awaited<ReturnType<typeof file>>;
  let refused: Awaited<ReturnType<typeof file>>;
  let notAPicture: Awaited<ReturnType<typeof file>>;

  beforeAll(async () => {
    pictures = await folder('Pictures for screens');
    good = await file('01 good.png', pictures.driveId);
    unknown = await file('02 unknown.png', pictures.driveId, { size: 300 });
    companion = await grandfathered('._01 good.png', pictures.driveId);
    // Indexed after the rule: `other` from the start, and still a file of the chosen folder.
    reclassified = await file('._02 unknown.png', pictures.driveId, { size: 250 });
    refused = await file('03 refused.jpg', pictures.driveId, { mime: 'image/jpeg' });
    notAPicture = await file('04 tiny.png', pictures.driveId, { size: 200 });
    await probe([
      { driveFileId: good.driveId, checksum: good.checksum, width: 1080, height: 1920 },
      { driveFileId: notAPicture.driveId, checksum: notAPicture.checksum, settled: true }
    ]);
    await verdict(refused.checksum, 'unusable', 'image/jpeg');
  });

  it('holds what is proven and what nothing is known about, and nothing proven useless', async () => {
    await setPool('end', [{ materialId: pictures.id }]);
    expect(await poolNames('end')).toEqual(['01 good.png', '02 unknown.png']);
  });

  it('leaves the declared pool, and the launch settings version hashed from it, exactly where they were', async () => {
    // A verdict arrives while a batch of launches accepted with this pool is still being made:
    // each of them compares this version, and a move would refuse them all (SOURCE_CHANGED).
    const declared = await declaredNames('end');
    expect(declared).toEqual([
      '._01 good.png',
      '01 good.png',
      '02 unknown.png',
      '03 refused.jpg',
      '04 tiny.png'
    ]);
    const before = await launchSettingsVersion();
    const late = await file('05 late.png', pictures.driveId);
    const withLate = await launchSettingsVersion();
    // The version does see the pool: a picture added to the folder moves it.
    expect(withLate).not.toBe(before);
    await verdict(late.checksum, 'unusable');
    await probe([{ driveFileId: unknown.driveId, checksum: unknown.checksum, settled: true }]);
    expect(await poolNames('end')).toEqual(['01 good.png']);
    expect(await launchSettingsVersion()).toBe(withLate);
    expect(await declaredNames('end')).toEqual([...declared, '05 late.png']);
    await harness.root('delete from public.team_materials where id = $1', [late.id]);
    await harness.root(
      'delete from private.restitch_screen_verdicts where team_id = $1 and checksum = $2',
      [space.teamId, late.checksum]
    );
    await harness.root('delete from private.drive_image_probes where drive_file_id = $1', [
      unknown.driveId
    ]);
    expect(await launchSettingsVersion()).toBe(before);
    expect(await poolNames('end')).toEqual(['01 good.png', '02 unknown.png']);
  });

  it('draws a screen only from the usable pictures', async () => {
    const drawn = new Set<string>();
    for (let round = 0; round < 24; round += 1) {
      const rows = await harness.root<{ draw: { screens: Array<{ slot: string; name: string }> } }>(
        `select private.draw_restitch_screens_for($1, null,
           '{"sourceMode":"drive","operation":"restitch","startEnabled":false,"endEnabled":true}'::jsonb,
           '{}') as draw`,
        [space.teamId]
      );
      for (const screen of rows[0]!.draw.screens) drawn.add(screen.name);
    }
    expect([...drawn].sort()).toEqual(['01 good.png', '02 unknown.png']);
  });

  it('tells the panel what it left out and why, counted the way the pool counts', async () => {
    const pool = (await listing()).pools.end;
    expect(pool.state).toBe('ready');
    expect(pool.eligibleCount).toBe(2);
    expect(pool.sources).toEqual([
      expect.objectContaining({
        name: 'Pictures for screens',
        availability: 'available',
        imageCount: 2
      })
    ]);
    expect(pool.unusable.count).toBe(4);
    expect(pool.unusable.items).toEqual([
      {
        materialId: companion.id,
        name: '._01 good.png',
        folderName: 'Pictures for screens',
        sizeBytes: 400,
        reason: 'service_file'
      },
      {
        materialId: reclassified.id,
        name: '._02 unknown.png',
        folderName: 'Pictures for screens',
        sizeBytes: 250,
        reason: 'service_file'
      },
      {
        materialId: refused.id,
        name: '03 refused.jpg',
        folderName: 'Pictures for screens',
        sizeBytes: 100_000,
        reason: 'undecodable'
      },
      {
        materialId: notAPicture.id,
        name: '04 tiny.png',
        folderName: 'Pictures for screens',
        sizeBytes: 200,
        reason: 'not_an_image'
      }
    ]);
    // The other slot draws from nothing and says so.
    expect((await listing()).pools.start.unusable).toEqual({ count: 0, items: [] });
  });

  it('freezes only usable candidates and stays complete: a known defect is not an unknown', async () => {
    const frozen = await snapshot('end');
    expect(frozen.candidates.map(candidate => candidate.materialId).sort()).toEqual(
      [good.id, unknown.id].sort()
    );
    expect(frozen).toMatchObject({
      complete: true,
      eligibleObserved: 2,
      // The grandfathered companion and the two refused pictures; the one indexed as `other`
      // is not an image the observation looks at.
      ineligibleObserved: 3,
      unknownObserved: 0,
      unknownSourceCount: 0
    });
  });

  it('judges a service file by its name before its missing metadata', async () => {
    await harness.root(
      'alter table public.team_materials disable trigger team_materials_os_service_file'
    );
    await harness.root(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
       values ($1, $2, 'unusable-bare', $3, '._bare.png', 'file', 'image', 'image/png')`,
      [space.teamId, space.connectionId, pictures.driveId]
    );
    await harness.root(
      'alter table public.team_materials enable trigger team_materials_os_service_file'
    );
    expect(await snapshot('end')).toMatchObject({ complete: true, unknownObserved: 0 });
    await harness.root("delete from public.team_materials where drive_file_id = 'unusable-bare'");
  });

  it('marks a refused picture chosen by itself as unsupported, without making the pool unknown', async () => {
    const pool = (
      await setPool('start', [{ materialId: refused.id }, { materialId: companion.id }])
    ).pools.start;
    expect(
      pool.sources.map(source => [source.name, source.availability, source.imageCount])
    ).toEqual([
      ['03 refused.jpg', 'unsupported', 0],
      ['._01 good.png', 'unsupported', 0]
    ]);
    expect(pool.eligibleCount).toBe(0);
    expect(pool.unusable.count).toBe(2);
    // The companion becomes `other` one day; it must then be a source that gives nothing, not
    // an unknown one that makes every admission uncertain.
    await harness.root("update public.team_materials set category = 'other' where id = $1", [
      companion.id
    ]);
    expect(await snapshot('start')).toMatchObject({
      complete: true,
      unknownSourceCount: 0,
      eligibleObserved: 0
    });
    await harness.root(
      'alter table public.team_materials disable trigger team_materials_os_service_file'
    );
    await harness.root("update public.team_materials set category = 'image' where id = $1", [
      companion.id
    ]);
    await harness.root(
      'alter table public.team_materials enable trigger team_materials_os_service_file'
    );
    await setPool('start', []);
  });

  it('takes a picture back when an agent decodes it, and when its bytes change', async () => {
    await verdict(refused.checksum, 'usable', 'image/jpeg');
    expect(await poolNames('end')).toEqual(['01 good.png', '02 unknown.png', '03 refused.jpg']);
    await verdict(refused.checksum, 'unusable', 'image/jpeg');
    expect(await poolNames('end')).toEqual(['01 good.png', '02 unknown.png']);
    await harness.root('update public.team_materials set checksum = $2 where id = $1', [
      refused.id,
      md5(800_001)
    ]);
    expect(await poolNames('end')).toEqual(['01 good.png', '02 unknown.png', '03 refused.jpg']);
    expect((await listing()).pools.end.unusable.count).toBe(3);
  });

  it('lets Soty’s standard picture stand in for a slot whose every picture is unusable', async () => {
    const effective = async () =>
      (
        await harness.root<{
          value: {
            startEnabled: boolean;
            builtin: { version: number; start: boolean; end: boolean };
          };
        }>('select private.effective_restitch_defaults_json($1, $2) as value', [
          space.teamId,
          RESTITCH_OWNER
        ])
      )[0]!.value;
    const useless = await folder('Only useless files');
    await grandfathered('._only.png', useless.driveId);
    const refusedOnly = await file('only-refused.jpg', useless.driveId, { mime: 'image/jpeg' });
    await verdict(refusedOnly.checksum, 'unusable', 'image/jpeg');
    const pool = (await setPool('start', [{ materialId: useless.id }])).pools.start;
    // The declared pool is not empty; nothing in it can be a screen.
    expect(await declaredNames('start')).toEqual(['._only.png', 'only-refused.jpg']);
    expect(pool).toMatchObject({ state: 'empty', eligibleCount: 0 });
    expect(pool.unusable.count).toBe(2);
    // «Switched-on re-stitching never fails»: the slot has no picture of its own, so the
    // standard one is used - and a new catalog set is not frozen with an empty candidate list.
    expect(await effective()).toMatchObject({
      startEnabled: false,
      builtin: { version: 1, start: true, end: false }
    });
    // One picture an agent can decode, and the slot is the space's own again.
    await verdict(refusedOnly.checksum, 'usable', 'image/jpeg');
    expect(await effective()).toMatchObject({
      startEnabled: true,
      builtin: { version: 1, start: false, end: false }
    });
    await setPool('start', []);
  });

  it('lists at most two hundred files and still counts them all', async () => {
    const many = await folder('Many companions');
    await harness.root(
      'alter table public.team_materials disable trigger team_materials_os_service_file'
    );
    await harness.root(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
          size_bytes, checksum, drive_version)
       select $1, $2, 'many-' || n, $3, '._' || lpad(n::text, 3, '0') || '.png', 'file', 'image',
              'image/png', 300, lpad(to_hex(n + 5000000), 32, '0'), '1'
         from generate_series(1, 230) as n`,
      [space.teamId, space.connectionId, many.driveId]
    );
    await harness.root(
      'alter table public.team_materials enable trigger team_materials_os_service_file'
    );
    const pool = (await setPool('start', [{ materialId: many.id }])).pools.start;
    expect(pool.state).toBe('empty');
    expect(pool.unusable.count).toBe(230);
    expect(pool.unusable.items).toHaveLength(200);
    expect(pool.unusable.items[0]!.name).toBe('._001.png');
    await setPool('start', []);
  });
});

describe('who may touch the evidence', () => {
  it('keeps both tables and every function away from browser roles', async () => {
    const tables = await harness.root<{ name: string; browser: boolean; service: boolean }>(
      `select c.relname as name,
              has_table_privilege('authenticated', c.oid, 'select')
                or has_table_privilege('anon', c.oid, 'select') as browser,
              has_table_privilege('service_role', c.oid, 'select,insert,update,delete') as service
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relname in ('restitch_screen_verdicts', 'drive_image_probes')`
    );
    expect(tables).toHaveLength(2);
    expect(tables.every(table => !table.browser && !table.service)).toBe(true);
    const forced = await harness.root<{ forced: boolean }>(
      `select relrowsecurity and relforcerowsecurity as forced from pg_class
        where relname in ('restitch_screen_verdicts', 'drive_image_probes')`
    );
    expect(forced.every(row => row.forced)).toBe(true);
    const functions = await harness.root<{ name: string; browser: boolean; service: boolean }>(
      `select p.proname as name,
              has_function_privilege('authenticated', p.oid, 'execute')
                or has_function_privilege('anon', p.oid, 'execute') as browser,
              has_function_privilege('service_role', p.oid, 'execute') as service
         from pg_proc p
        where p.proname in ('service_record_restitch_screen_verdict',
          'service_record_drive_image_probes', 'restitch_screen_defect', 'os_service_file_name',
          'restitch_pool_usable_images', 'restitch_pool_unusable_json', 'team_material_os_service_file')
        order by p.proname`
    );
    expect(functions.map(fn => [fn.name, fn.browser, fn.service])).toEqual([
      ['os_service_file_name', false, false],
      ['restitch_pool_unusable_json', false, false],
      ['restitch_pool_usable_images', false, false],
      ['restitch_screen_defect', false, false],
      ['service_record_drive_image_probes', false, true],
      ['service_record_restitch_screen_verdict', false, true],
      ['team_material_os_service_file', false, false]
    ]);
  });

  it('stays outside the task-cleanup inventory, which stays verified', async () => {
    const inventory = await harness.root<{ table_name: string }>(
      `select table_name from private.task_cleanup_reference_tables()
        where table_name in ('restitch_screen_verdicts', 'drive_image_probes')`
    );
    // Neither table can hold a reference to a material: no foreign key to one, no JSON.
    expect(inventory).toEqual([]);
    const verified = await harness.root<{ ok: boolean }>(
      'select private.task_cleanup_coverage_verified() as ok'
    );
    expect(verified[0]!.ok).toBe(true);
  });
});

describe('the rows that existed before the rule', () => {
  const MIGRATION = 'supabase/migrations/20261224451000_unusable_screen_images_data.sql';

  it('applies the schema migration a second time without changing or losing anything', async () => {
    const before = await harness.root<{ verdicts: number; probes: number; definition: string }>(
      `select (select count(*)::integer from private.restitch_screen_verdicts) as verdicts,
              (select count(*)::integer from private.drive_image_probes) as probes,
              pg_get_functiondef('private.effective_restitch_defaults_json(uuid,uuid)'::regprocedure)
                as definition`
    );
    await harness.db.exec(
      readFileSync('supabase/migrations/20261224450000_unusable_screen_images.sql', 'utf8')
    );
    const after = await harness.root<{ verdicts: number; probes: number; definition: string }>(
      `select (select count(*)::integer from private.restitch_screen_verdicts) as verdicts,
              (select count(*)::integer from private.drive_image_probes) as probes,
              pg_get_functiondef('private.effective_restitch_defaults_json(uuid,uuid)'::regprocedure)
                as definition`
    );
    expect(after).toEqual(before);
    expect(before[0]!.verdicts).toBeGreaterThan(0);
    expect(before[0]!.definition).toContain('restitch_pool_usable_images');
    expect(before[0]!.definition).not.toContain('restitch_pool_images(');
    const triggers = await harness.root<{ count: number }>(
      "select count(*)::integer as count from pg_trigger where tgname = 'team_materials_os_service_file'"
    );
    expect(triggers[0]!.count).toBe(1);
  });

  it('moves service files indexed earlier, except those a pool or a candidate list still names', async () => {
    const free = await grandfathered('._free.png', 'root');
    const inSet = await grandfathered('._in-set.png', 'root');
    const inRoot = await grandfathered('._in-root.png', 'root');
    const picture = await file('ordinary.png', 'root');
    const chosen = await folder('Chosen for screens');
    const member = await grandfathered('._member.png', chosen.driveId);
    await setPool('start', [{ materialId: chosen.id }]);
    const before = await launchSettingsVersion();
    // Only the two candidate tables the statement reads; their parents are another suite's subject.
    await harness.root("set session_replication_role = 'replica'");
    try {
      await harness.root(
        `insert into private.catalog_video_restitch_candidates
           (video_set_id, team_id, slot, version_id, material_id, ordinal, size_bytes, mime_type,
            checksum, drive_version, connection_id, drive_file_id, parent_folder_id, root_folder_id)
         values ('00000000-0000-4000-8000-0000000000a1', $1, 'end',
                 '00000000-0000-4000-8000-0000000000b1', $2, 1, 400, 'image/png', $3, '1', $4, $5,
                 'root', 'root')`,
        [space.teamId, inSet.id, inSet.checksum, space.connectionId, inSet.driveId]
      );
      await harness.root(
        `insert into private.restitch_selection_candidates
           (root_operation_id, slot, version_id, material_id, ordinal, size_bytes, mime_type,
            checksum, drive_version, connection_id, drive_file_id, parent_folder_id, root_folder_id)
         values ('00000000-0000-4000-8000-0000000000c1', 'end',
                 '00000000-0000-4000-8000-0000000000b2', $1, 1, 400, 'image/png', $2, '1', $3, $4,
                 'root', 'root')`,
        [inRoot.id, inRoot.checksum, space.connectionId, inRoot.driveId]
      );
    } finally {
      await harness.root("set session_replication_role = 'origin'");
    }
    const sql = readFileSync(MIGRATION, 'utf8');
    await harness.db.exec(sql);
    expect((await category(free.id)).category).toBe('other');
    // A frozen list hands these to a variant, which is refused when one stops being an image.
    expect((await category(inSet.id)).category).toBe('image');
    expect((await category(inRoot.id)).category).toBe('image');
    // A declared pool holds this one: moving it would move every accepted launch's version.
    expect((await category(member.id)).category).toBe('image');
    expect(await launchSettingsVersion()).toBe(before);
    expect((await category(picture.id)).category).toBe('image');
    // Nothing names them any more: the same statement, run again, moves them.
    await harness.root("set session_replication_role = 'replica'");
    await harness.root(
      "delete from private.catalog_video_restitch_candidates where video_set_id = '00000000-0000-4000-8000-0000000000a1'"
    );
    await harness.root(
      "delete from private.restitch_selection_candidates where root_operation_id = '00000000-0000-4000-8000-0000000000c1'"
    );
    await harness.root("set session_replication_role = 'origin'");
    await setPool('start', []);
    await harness.db.exec(sql);
    for (const moved of [inSet, inRoot, member])
      expect((await category(moved.id)).category).toBe('other');
    expect((await category(picture.id)).category).toBe('image');
  });

  it('remembers what agents already wrote in the journal, from members only, once', async () => {
    const rejected = await file('journal-rejected.jpg', 'root', { mime: 'image/jpeg' });
    const strangers = await file('journal-stranger.jpg', 'root', { mime: 'image/jpeg' });
    const versions = await harness.root<{ rejected: string; strangers: string }>(
      `select private.register_restitch_candidate_version($1, $2) as rejected,
              private.register_restitch_candidate_version($1, $3) as strangers`,
      [space.teamId, rejected.id, strangers.id]
    );
    const outsider = '30000000-0000-4000-8000-000000000009';
    const record = (user: string, sequence: number, props: Record<string, unknown>) =>
      harness.root(
        `insert into public.agent_journal_records
           (user_id, agent_instance_id, seq, recorded_at, category, code, props)
         values ($1, '00000000-0000-4000-8000-00000000a6e7', $2, clock_timestamp(), 'team',
                 'screen_candidate_rejected', $3::jsonb)`,
        [user, sequence, JSON.stringify(props)]
      );
    await record(RESTITCH_OWNER, 1, {
      versionId: versions[0]!.rejected,
      reason: 'unsupported_image',
      slot: 'end'
    });
    await record(RESTITCH_OWNER, 2, {
      versionId: versions[0]!.rejected.toUpperCase(),
      reason: 'unsupported_image',
      slot: 'start'
    });
    // Not a property of the bytes, not a member, not a version at all.
    await record(RESTITCH_OWNER, 3, {
      versionId: versions[0]!.strangers,
      reason: 'source_missing'
    });
    await record(outsider, 4, { versionId: versions[0]!.strangers, reason: 'unsupported_image' });
    await record(RESTITCH_OWNER, 5, { versionId: 'not-a-uuid', reason: 'unsupported_image' });
    await record(RESTITCH_OWNER, 6, { reason: 'unsupported_image' });
    const sql = readFileSync(MIGRATION, 'utf8');
    await harness.db.exec(sql);
    await harness.db.exec(sql);
    const rows = await harness.root<{ verdict: string; rejections: number }>(
      'select verdict, rejections from private.restitch_screen_verdicts where team_id = $1 and checksum = $2',
      [space.teamId, rejected.checksum]
    );
    expect(rows).toEqual([{ verdict: 'unusable', rejections: 2 }]);
    expect(await defect(rejected)).toBe('undecodable');
    expect(await defect(strangers)).toBeNull();
  });
});
