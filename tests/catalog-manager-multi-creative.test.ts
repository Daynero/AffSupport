import { describe, expect, it } from 'vitest';
import {
  catalogHasOneVideo,
  catalogUpdateFieldAllowed,
  type CatalogUpdateField
} from '../packages/shared/src/team/catalog-updater';

const fields: CatalogUpdateField[] = [
  'restitch',
  'randomLinkVariation',
  'refreshImages',
  'refreshTexts',
  'growProducts'
];
const allowed = (profile: Parameters<typeof catalogUpdateFieldAllowed>[0]) =>
  fields.filter(field => catalogUpdateFieldAllowed(profile, field));

describe('catalog manager actions (FR-022)', () => {
  it('keeps everything for a single video, including older catalogs', () => {
    expect(allowed({})).toEqual(fields);
    expect(allowed({ creativeKind: 'video', creatives: [{ alias: 'a', kind: 'video' }] })).toEqual(
      fields
    );
    expect(catalogHasOneVideo({})).toBe(true);
  });
  it('keeps restitch and texts for several videos', () => {
    const profile = {
      creativeKind: 'video' as const,
      creatives: [
        { alias: 'a', kind: 'video' as const },
        { alias: 'b', kind: 'video' as const }
      ]
    };
    expect(allowed(profile)).toEqual(['restitch', 'refreshTexts']);
    expect(catalogHasOneVideo(profile)).toBe(false);
  });
  it('keeps only texts for images, even a single one', () => {
    const profile = { creativeKind: 'image' as const, creatives: [{ alias: 'a', kind: 'image' as const }] };
    expect(allowed(profile)).toEqual(['refreshTexts']);
    expect(catalogHasOneVideo(profile)).toBe(false);
  });
});
