import { expect, it } from 'vitest';
import {
  parseLaunchConfig,
  parseLaunchDraft,
  launchPreview,
  launchRevisionImpact
} from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';
const config = () =>
  launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 5,
      restitchEnabled: true,
      finalDurationMode: 'random-centered',
      customFinalDurationSeconds: 1800,
      finalDurationRangeSeconds: [1200, 2400],
      catalogVideoProtocolVersion: 1,
      videoVariationCount: 5,
      videoPublication: {
        mode: 'scheduled',
        localDateTime: '2020-01-01T12:00',
        timeZone: 'Europe/Kyiv',
        resolvedOffset: '+02:00',
        dueAt: '2020-01-01T10:00:00.000Z'
      }
    }
  });
it('round trips original N/publication choices without expiring historical revisions', () => {
  const raw = config();
  expect(parseLaunchDraft(raw)?.catalog).toEqual(raw.catalog);
  const parsed = parseLaunchConfig(raw);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.catalog).toEqual(raw.catalog);
});
it('refuses an active count above products and a mismatching publication proof', () => {
  const raw = config();
  expect(
    parseLaunchConfig({ ...raw, catalog: { ...raw.catalog, videoVariationCount: 6 } }).ok
  ).toBe(false);
  expect(
    parseLaunchConfig({
      ...raw,
      catalog: {
        ...raw.catalog,
        videoPublication: {
          ...raw.catalog.videoPublication,
          mode: 'scheduled',
          dueAt: '2020-01-01T11:00:00.000Z'
        }
      }
    }).ok
  ).toBe(false);
});
it('preserves unfinished calendar drafts while blocking generation', () => {
  const raw = config();
  const draft = {
    ...raw,
    catalog: {
      ...raw.catalog,
      videoPublication: {
        mode: 'scheduled',
        localDateTime: 'T12:00',
        timeZone: 'Europe/Kyiv',
        resolvedOffset: '',
        dueAt: ''
      }
    }
  };
  expect(parseLaunchDraft(draft)).not.toBeNull();
  expect(parseLaunchConfig(draft).ok).toBe(false);
});
it('keeps legacy configs absent and detects N/schedule changes as catalog changes', () => {
  const before = launchConfig({ method: 'catalog' });
  expect(parseLaunchDraft(before)?.catalog).not.toHaveProperty('catalogVideoProtocolVersion');
  const preview = launchPreview(before, launchSources);
  if (!preview.ok) throw Error('fixture');
  for (const patch of [
    {
      catalogVideoProtocolVersion: 1 as const,
      videoVariationCount: 1,
      videoPublication: { mode: 'immediate' as const }
    },
    {
      catalogVideoProtocolVersion: 1 as const,
      videoVariationCount: 2,
      videoPublication: { mode: 'immediate' as const }
    }
  ]) {
    const after = { ...before, catalog: { ...before.catalog, ...patch } };
    expect(launchRevisionImpact(preview.value, preview.value, before, after).catalogChanged).toBe(
      true
    );
  }
});
