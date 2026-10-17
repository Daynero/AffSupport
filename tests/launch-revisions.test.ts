import { describe, expect, it } from 'vitest';
import {
  launchPreview,
  launchRevisionImpact,
  parseLaunchOverrides
} from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';
describe('Launch output revisions', () => {
  it('ignores an inactive custom duration while the selected restitch mode is random', () => {
    const before = launchConfig({
      method: 'catalog',
      catalog: {
        productCount: 100,
        restitchEnabled: true,
        finalDurationMode: 'random-30-40',
        customFinalDurationSeconds: 60
      }
    });
    const after = { ...before, catalog: { ...before.catalog, customFinalDurationSeconds: 120 } };
    const preview = launchPreview(before, launchSources);
    if (!preview.ok) throw new Error('fixture');
    expect(launchRevisionImpact(preview.value, preview.value, before, after)).toMatchObject({
      mediaChanged: false,
      catalogChanged: false
    });
  });
  it('ignores unused Buyer and names-only changes for catalog regeneration', () => {
    const a = launchConfig({
      method: 'catalog',
      subConfig: { schemaVersion: 1, sub1: [], sub2: [], sub3: [] }
    });
    const b = { ...a, age: 50 };
    const pa = launchPreview(a, launchSources);
    const pb = launchPreview(b, { ...launchSources, buyer: 'guru' });
    if (!pa.ok || !pb.ok) throw new Error('fixture');
    expect(launchRevisionImpact(pa.value, pb.value, a, b)).toEqual({
      namesChanged: true,
      urlChanged: false,
      mediaChanged: false,
      catalogChanged: false
    });
  });
  it('requires a new catalog for an actually changed URL, keeping media reusable', () => {
    const a = launchConfig({ method: 'catalog' });
    const b = { ...a, originalUrl: 'https://example.invalid/new' };
    const pa = launchPreview(a, launchSources);
    const pb = launchPreview(b, launchSources);
    if (!pa.ok || !pb.ok) throw new Error('fixture');
    expect(launchRevisionImpact(pa.value, pb.value, a, b)).toEqual({
      namesChanged: false,
      urlChanged: true,
      mediaChanged: false,
      catalogChanged: true
    });
  });
  it('keeps budget and ad-range edits in the naming revision, but invalidates changed active restitch settings', () => {
    const before = launchConfig({
      method: 'catalog',
      catalog: {
        productCount: 100,
        restitchEnabled: true,
        finalDurationMode: 'custom',
        customFinalDurationSeconds: 60
      }
    });
    const namesOnly = { ...before, maxBudget: 60, adsCount: 4 };
    const changedMedia = {
      ...before,
      catalog: { ...before.catalog, customFinalDurationSeconds: 120 }
    };
    const baseline = launchPreview(before, launchSources);
    const renamed = launchPreview(namesOnly, launchSources);
    const restitched = launchPreview(changedMedia, launchSources);
    if (!baseline.ok || !renamed.ok || !restitched.ok) throw new Error('fixture');
    expect(launchRevisionImpact(baseline.value, renamed.value, before, namesOnly)).toEqual({
      namesChanged: true,
      urlChanged: false,
      mediaChanged: false,
      catalogChanged: false
    });
    expect(
      launchRevisionImpact(baseline.value, restitched.value, before, changedMedia)
    ).toMatchObject({ mediaChanged: true, catalogChanged: true });
  });
  it('validates manual values without recalculating dependent outputs', () => {
    expect(
      parseLaunchOverrides(
        {
          advertisingUrl: 'https://example.invalid/manual',
          campaigns: { '1': { budget: '77', name: 'manual' } }
        },
        3
      ).ok
    ).toBe(true);
    for (const v of [
      { campaigns: { '4': { name: 'x' } } },
      { campaigns: { '1': { budget: '0' } } },
      { campaigns: { '01': { name: 'x' } } },
      { campaigns: { '1': { budget: '077' } } },
      { campaigns: { '1': { adRange: '01-3' } } },
      { campaigns: { '1': { budget: '9007199254740992' } } },
      { campaigns: { '1': { adRange: '9-1' } } },
      { subValues: { sub1: 'кирилиця' } },
      { state: 'succeeded' }
    ])
      expect(parseLaunchOverrides(v, 3).ok).toBe(false);
  });
});

it('uses source and settings identity for cache decisions, ignoring disabled restitch fields', () => {
  const before = launchConfig({ method: 'catalog' });
  const after = {
    ...before,
    age: 50,
    catalog: {
      ...before.catalog,
      finalDurationMode: 'custom' as const,
      customFinalDurationSeconds: null
    }
  };
  const a = launchPreview(before, launchSources),
    b = launchPreview(after, launchSources);
  if (!a.ok || !b.ok) throw new Error('fixture');
  const known = {
    ...launchSources,
    catalogSettingsVersion: 'settings-v1',
    restitchSettingsVersion: null
  };
  expect(launchRevisionImpact(a.value, b.value, before, after, known, known).catalogChanged).toBe(
    false
  );
  expect(
    launchRevisionImpact(a.value, b.value, before, after, known, { ...known, materialVersion: '2' })
      .mediaChanged
  ).toBe(true);
  expect(
    launchRevisionImpact(a.value, b.value, before, after, known, {
      ...known,
      catalogSettingsVersion: 'settings-v2'
    })
  ).toMatchObject({ mediaChanged: false, catalogChanged: true });
  expect(
    launchRevisionImpact(a.value, b.value, before, after, known, {
      ...known,
      materialVersion: null
    })
  ).toMatchObject({ mediaChanged: true, catalogChanged: true });
});

it('reuses unchanged binary content after a permission-only provider version change', () => {
  const config = launchConfig({ method: 'catalog' });
  const a = launchPreview(config, launchSources);
  if (!a.ok) throw new Error('fixture');
  const source = {
    ...launchSources,
    materialChecksum: 'a'.repeat(32),
    materialDriveFileId: 'video-drive',
    catalogSettingsVersion: 'settings1'
  };
  expect(
    launchRevisionImpact(a.value, a.value, config, config, source, {
      ...source,
      materialVersion: '2'
    }).catalogChanged
  ).toBe(false);
  expect(
    launchRevisionImpact(a.value, a.value, config, config, source, {
      ...source,
      materialChecksum: 'b'.repeat(32)
    }).catalogChanged
  ).toBe(true);
  expect(
    launchRevisionImpact(a.value, a.value, config, config, source, {
      ...source,
      materialDriveFileId: 'replacement-drive'
    }).catalogChanged
  ).toBe(true);
});

it('keeps historical output immutable when a named source changes and derives only the next revision', () => {
  const config = launchConfig({ method: 'catalog' });
  const historicalSources = { ...launchSources, catalogSettingsVersion: 'settings-v1' };
  const historical = launchPreview(config, historicalSources);
  const renamedSources = { ...historicalSources, offer: 'Renamed offer' };
  const next = launchPreview(config, renamedSources);
  if (!historical.ok || !next.ok) throw new Error('fixture');
  const historicalSnapshot = structuredClone(historical.value);
  expect(next.value.campaigns).not.toEqual(historical.value.campaigns);
  expect(historical.value).toEqual(historicalSnapshot);
  expect(
    launchRevisionImpact(
      historical.value,
      next.value,
      config,
      config,
      historicalSources,
      renamedSources
    )
  ).toMatchObject({ namesChanged: true, mediaChanged: false, catalogChanged: false });
});

it('changes the URL only when the Buyer is actually used by the frozen SUB recipe', () => {
  const config = launchConfig({
    method: 'catalog',
    originalUrl: 'https://example.invalid/?sub1=old&pixel=token'
  });
  const before = { ...launchSources, buyer: 'patrik', catalogSettingsVersion: 'settings-v1' };
  const after = { ...before, buyer: 'newbuyer' };
  const oldPreview = launchPreview(config, before);
  const nextPreview = launchPreview(config, after);
  if (!oldPreview.ok || !nextPreview.ok) throw new Error('fixture');
  const frozen = structuredClone(oldPreview.value);
  expect(
    launchRevisionImpact(oldPreview.value, nextPreview.value, config, config, before, after)
  ).toMatchObject({
    namesChanged: false,
    urlChanged: true,
    mediaChanged: false,
    catalogChanged: true
  });
  expect(oldPreview.value).toEqual(frozen);

  const withoutBuyer = {
    ...config,
    subConfig: { schemaVersion: 1 as const, sub1: [], sub2: [], sub3: [] }
  };
  const a = launchPreview(withoutBuyer, before);
  const b = launchPreview(withoutBuyer, after);
  if (!a.ok || !b.ok) throw new Error('fixture');
  expect(launchRevisionImpact(a.value, b.value, withoutBuyer, withoutBuyer, before, after)).toEqual(
    { namesChanged: false, urlChanged: false, mediaChanged: false, catalogChanged: false }
  );
});

it('does not reuse media when a formerly available source loses its binary identity', () => {
  const config = launchConfig({ method: 'catalog' });
  const preview = launchPreview(config, launchSources);
  if (!preview.ok) throw new Error('fixture');
  const known = {
    ...launchSources,
    materialChecksum: 'a'.repeat(32),
    materialDriveFileId: 'video-drive',
    catalogSettingsVersion: 'settings-v1'
  };
  const removed = { ...known, materialChecksum: undefined, materialVersion: null };
  expect(
    launchRevisionImpact(preview.value, preview.value, config, config, known, removed)
  ).toMatchObject({ mediaChanged: true, catalogChanged: true });
});
