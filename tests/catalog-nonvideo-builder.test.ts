import { expect, it } from 'vitest';
import {
  rebuildCatalogRows,
  catalogVideoColumnIndices,
  catalogNonVideoCellUpdates
} from '../supabase/functions/_shared/catalog-updater';
import { PRODUCT_CATALOG_TEMPLATE } from '../supabase/functions/_shared/product-catalog';
const record = {
  settings: {
    title: 'New title',
    description: 'New description',
    price: 100,
    imageLink: 'https://fixture.invalid/image'
  },
  sourceLink: 'https://fixture.invalid/source',
  videoLink: 'https://fixture.invalid/PENDING',
  productCount: 2
};
it('preserves exact actual old or blank cells without substituting pending metadata links', () => {
  for (const cells of [
    ['https://fixture.invalid/OLD?v=custom', 'https://fixture.invalid/OTHER'],
    ['', '']
  ]) {
    const rows = rebuildCatalogRows({ record, preservedVideoCells: cells });
    for (const column of catalogVideoColumnIndices())
      expect(rows.slice(2).map(row => row[column]!.v)).toEqual(cells);
    expect(JSON.stringify(rows)).not.toContain('/PENDING');
  }
});
it('targeted ordinary writes exclude every video dependency and retain all nonvideo fields', () => {
  const rows = rebuildCatalogRows({ record, preservedVideoCells: ['', ''] });
  const updates = catalogNonVideoCellUpdates(rows, 7),
    excluded = new Set(catalogVideoColumnIndices());
  const addressed = new Set<string>();
  for (const update of updates)
    for (let offset = 0; offset < update.values.length; offset++) {
      const column = update.columnIndex;
      expect(excluded.has(column)).toBe(false);
      addressed.add(update.rowIndex + offset + ':' + column);
    }
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < PRODUCT_CATALOG_TEMPLATE.length; c++)
      expect(addressed.has(r + ':' + c)).toBe(!excluded.has(c));
});
it('does not invent blank cells when the observed snapshot or grown recipe is incomplete', () => {
  expect(() => rebuildCatalogRows({ record, preservedVideoCells: [''] })).toThrow('INVALID_INPUT');
  expect(() => catalogNonVideoCellUpdates([], 0)).toThrow('INVALID_INPUT');
});
