import { expect, it } from 'vitest';
import {
  launchPreview,
  launchSubPreview,
  parseLaunchSubConfig,
  parseLaunchConfig
} from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';

it('defers catalog-dependent slots without guessing a version or corrupting raw URL bytes', () => {
  const config = launchConfig({
    method: 'catalog',
    originalUrl: 'https://example.invalid/?sub1=old&sub2=stay&m={{id}}#fragment',
    subConfig: { schemaVersion: 1, sub1: ['buyer', 'catalogName'], sub2: ['creative'], sub3: [] }
  });
  const preview = launchPreview(config, launchSources);
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error('Expected valid deferred preview');
  expect(preview.value.subValues.sub1).toBeNull();
  expect(preview.value.advertisingUrl).toContain('sub1=old');
  const resolved = launchPreview(config, launchSources, 'Video 01_v27_catalog');
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error('Expected valid resolved preview');
  expect(resolved.value.subValues.sub1).toBe(`${launchSources.buyer}-Video 01_v27_catalog`);
  expect(resolved.value.advertisingUrl).toContain('Video%2001_v27_catalog');
  expect(resolved.value.advertisingUrl).toContain('m={{id}}#fragment');
  expect(launchSubPreview(config.subConfig, config.creativeAlias, launchSources).sub1).toBeNull();
});
it('accepts all five unique variables and rejects duplicates or a catalog token without catalog generation', () => {
  const subConfig = {
    schemaVersion: 1 as const,
    sub1: ['buyer', 'social', 'adAccountSuffix', 'creative', 'catalogName'] as const,
    sub2: [],
    sub3: []
  };
  expect(parseLaunchSubConfig(subConfig)).not.toBeNull();
  expect(parseLaunchSubConfig({ ...subConfig, sub1: ['catalogName', 'catalogName'] })).toBeNull();
  expect(
    parseLaunchConfig(
      launchConfig({ method: 'other', subConfig: { ...subConfig, sub1: ['catalogName'] } })
    ).ok
  ).toBe(false);
});
it('rejects unsafe or oversized actual catalog names and keeps other missing values invalid', () => {
  const config = launchConfig({
    method: 'catalog',
    subConfig: { schemaVersion: 1, sub1: ['buyer', 'catalogName'], sub2: [], sub3: [] }
  });
  for (const name of ['bad\nname', 'x'.repeat(513)])
    expect(launchPreview(config, launchSources, name).ok).toBe(false);
  expect(launchPreview(config, { ...launchSources, buyer: '' }).ok).toBe(false);
});
