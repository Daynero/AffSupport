import { describe, expect, it } from 'vitest';
import {
  MATERIAL_CATEGORIES,
  TEAM_MATERIAL_ROW_KINDS,
  materialKindOf
} from '../packages/shared/src/team/index';

/**
 * The explorer shows one of nine kinds per row. The rule lives once in the
 * shared package and once in SQL (`team_material_kind`, feature 011 T015); this
 * file pins the shared half so the SQL half has something exact to agree with.
 */
describe('materialKindOf', () => {
  it('lets the stored kind win for folders and shortcuts', () => {
    expect(materialKindOf({ storedKind: 'folder', mimeType: null, category: null })).toBe('folder');
    expect(
      materialKindOf({ storedKind: 'shortcut', mimeType: 'image/png', category: 'image' })
    ).toBe('shortcut');
  });

  it('recognises provider-native folders and shortcuts by mime as well', () => {
    expect(
      materialKindOf({
        storedKind: 'file',
        mimeType: 'application/vnd.google-apps.folder',
        category: null
      })
    ).toBe('folder');
    expect(
      materialKindOf({
        storedKind: 'file',
        mimeType: 'application/vnd.google-apps.shortcut',
        category: null
      })
    ).toBe('shortcut');
  });

  it('calls every other provider-native mime a document', () => {
    for (const suffix of ['document', 'spreadsheet', 'presentation', 'form', 'drawing']) {
      expect(
        materialKindOf({
          storedKind: 'file',
          mimeType: `application/vnd.google-apps.${suffix}`,
          category: 'other'
        })
      ).toBe('document');
    }
  });

  it('maps every catalog category to a row kind', () => {
    const expected: Record<(typeof MATERIAL_CATEGORIES)[number], string> = {
      image: 'image',
      video: 'video',
      landing: 'landing',
      archive: 'archive',
      transcript: 'transcript',
      other: 'other'
    };
    for (const category of MATERIAL_CATEGORIES) {
      expect(materialKindOf({ storedKind: 'file', mimeType: 'x/y', category })).toBe(
        expected[category]
      );
    }
  });

  it('never returns something outside the published set', () => {
    for (const category of [null, undefined, 'nonsense', 42]) {
      const kind = materialKindOf({ storedKind: 'file', mimeType: undefined, category });
      expect(TEAM_MATERIAL_ROW_KINDS).toContain(kind);
      expect(kind).toBe('other');
    }
  });
});
