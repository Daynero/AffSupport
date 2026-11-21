import { expect, it } from 'vitest';
import {
  parseCatalogPublicationCommand,
  parseCatalogPublicationSnapshot
} from '../packages/shared/src/team/catalog-publication-api';
const id = '77000000-0000-4000-8000-000000000010',
  source = '77000000-0000-4000-8000-000000000011';
const target = { kind: 'source', materialId: source, sourceVersion: 'v1' };
const draft = {
  catalogId: id,
  serverNow: Date.parse('2030-01-01T00:00:00Z'),
  revision: 0,
  mode: 'immediate',
  dueAt: null,
  timeZone: null,
  target,
  job: null,
  active: null
};
it('parses a trusted initial draft without claiming existing metadata proves publication', () => {
  expect(parseCatalogPublicationSnapshot(draft)).toMatchObject({
    revision: 0,
    active: null,
    target
  });
});
it('refuses missing policy/clock/target fields instead of assuming immediate', () => {
  for (const value of [
    { ...draft, mode: undefined },
    { ...draft, serverNow: undefined },
    { ...draft, target: null },
    { ...draft, dueAt: '2030-01-01T00:00:00Z' }
  ])
    expect(parseCatalogPublicationSnapshot(value)).toBeNull();
});
it('requires an explicit publication command and preserves held semantics', () => {
  const raw = {
    requestId: id,
    catalogId: id,
    expectedRevision: 0,
    publication: { mode: 'held' },
    target
  };
  expect(parseCatalogPublicationCommand(raw, draft.serverNow).publication.mode).toBe('held');
  expect(() =>
    parseCatalogPublicationCommand({ ...raw, publication: undefined }, draft.serverNow)
  ).toThrow('INVALID_INPUT');
  expect(() =>
    parseCatalogPublicationCommand({ ...raw, expectedRevision: -1 }, draft.serverNow)
  ).toThrow('INVALID_INPUT');
});
it('validates scheduled commands against trusted time and exact zone/offset', () => {
  const raw = {
    requestId: id,
    catalogId: id,
    expectedRevision: 0,
    publication: {
      mode: 'scheduled',
      localDateTime: '2030-01-01T12:00',
      timeZone: 'UTC',
      resolvedOffset: '+00:00',
      dueAt: '2030-01-01T12:00:00Z'
    },
    target
  };
  expect(parseCatalogPublicationCommand(raw, draft.serverNow).publication.mode).toBe('scheduled');
  expect(() => parseCatalogPublicationCommand(raw, Date.parse('2030-01-02T00:00:00Z'))).toThrow(
    'INVALID_INPUT'
  );
});

/**
 * 062 gave a catalog made from several creatives, or from images, a 'creatives' target.
 * The snapshot parser knew only 'source' and 'video_set', so every read of such a catalog
 * failed as INVALID_RESPONSE and its launch result said the publication was never confirmed
 * (next, 2026-11-21). The shapes below are the server's own, read from production.
 */
const creatives = (kind: 'video' | 'image') => ({
  kind: 'creatives',
  segments: [
    {
      kind,
      materialId: '571fdd50-da82-42eb-ba1a-dd39e1637808',
      ordinal: 0,
      rowCount: 50,
      rowStart: 0,
      sourceVersion: 'content-v1:017b0a9ccb081d9ee736ebf73856d014c8c88c3ebe288d280a0b6b0eb3c5d25d'
    },
    {
      kind,
      materialId: '5A987EC8-1A91-439A-A60E-B6A77D50FB5C',
      ordinal: 1,
      rowCount: 50,
      rowStart: 50,
      sourceVersion: 'content-v1:a8f3a1edbbf795de1943175d2414ac93534f3866f1c20fb48e3cc9647f8c21fc'
    }
  ]
});

it('reads a catalog of several videos, and one of images, by its creatives target', () => {
  for (const kind of ['video', 'image'] as const) {
    const parsed = parseCatalogPublicationSnapshot({ ...draft, target: creatives(kind) });
    expect(parsed?.target).toEqual({
      kind: 'creatives',
      segments: [
        expect.objectContaining({ ordinal: 0, kind, rowStart: 0, rowCount: 50 }),
        expect.objectContaining({
          ordinal: 1,
          materialId: '5a987ec8-1a91-439a-a60e-b6a77d50fb5c',
          rowStart: 50
        })
      ]
    });
  }
  // A restitched segment carries its video set; an image segment its published picture.
  const restitched = creatives('video');
  restitched.segments[0] = {
    ...restitched.segments[0]!,
    videoSetId: '77000000-0000-4000-8000-0000000000a1',
    recipeRevision: 1
  } as (typeof restitched.segments)[0];
  expect(parseCatalogPublicationSnapshot({ ...draft, target: restitched })).not.toBeNull();
});

it('still refuses a creatives target that is not what the server writes', () => {
  const broken = (patch: Record<string, unknown>, index = 0) => {
    const value = creatives('video');
    value.segments[index] = { ...value.segments[index]!, ...patch } as (typeof value.segments)[0];
    return { ...draft, target: value };
  };
  for (const value of [
    broken({ ordinal: 5 }),
    broken({ kind: 'audio' }),
    broken({ materialId: 'not-a-uuid' }),
    broken({ rowStart: 380, rowCount: 50 }),
    broken({ videoSetId: '77000000-0000-4000-8000-0000000000a1' }),
    broken({ imageId: '77000000-0000-4000-8000-0000000000a2' }),
    { ...draft, target: { ...creatives('video'), extra: true } },
    { ...draft, target: { kind: 'creatives', segments: 'all' } }
  ])
    expect(parseCatalogPublicationSnapshot(value)).toBeNull();
});
