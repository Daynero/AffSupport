import { describe, expect, it } from 'vitest';
import { customIntervalFromHours } from '../apps/web/src/team/catalog-updater/limits.js';
import {
  CATALOG_UPDATER_COLUMNS,
  parseUpdaterInterval,
  updaterIntervalSeconds,
  rebuildCatalogRows,
  retryDelaySeconds
} from '../supabase/functions/_shared/catalog-updater.js';
import { buildProductCatalogRows } from '../supabase/functions/_shared/product-catalog.js';
import { contentId } from '../supabase/functions/_shared/product-details.js';

/**
 * Feature 023, as 025 left it: how an update moves a catalog on. IDs were the row number plus a
 * growing offset; a re-created catalog started at 1 again and Meta remembered what it had rejected
 * under those IDs. Now every write mints IDs of its own, and nothing else in the sheet moves.
 */

const record = {
  settings: {
    title: 'Polo',
    description: 'Knit',
    price: 10,
    imageLink: 'https://img.example.test/a.png'
  },
  sourceLink: 'https://offer.example.test/?sub=1',
  videoLink: 'https://drive.google.com/file/d/video/view?usp=sharing',
  productCount: 100
};

const ids = (rows: { t: string; v: string | number }[][]) =>
  rows.slice(2).map(row => String(row[CATALOG_UPDATER_COLUMNS.id]!.v));

describe('the ID rule', () => {
  it('writes an ID no catalog has used, on every write', () => {
    const first = ids(rebuildCatalogRows({ record }));
    const again = ids(rebuildCatalogRows({ record }));
    expect(new Set(first).size).toBe(100);
    // 025: row numbers came back to 1 whenever a catalog was re-created, and Meta remembered the
    // rejections they carried. Nothing an update writes may repeat what an earlier write wrote.
    expect(first.some(id => again.includes(id))).toBe(false);
    expect(first.every(id => /^[0-9A-Z]+-[0-9A-Z]{7}$/u.test(id))).toBe(true);
  });

  it('is made of the time it was written and a drawn tail', () => {
    const at = Date.UTC(2026, 8, 18, 12, 0, 0);
    const id = contentId(at, () => 0);
    expect(id).toBe(`${at.toString(36).toUpperCase()}-0000000`);
    expect(contentId(at, () => 0.99)).toBe(`${at.toString(36).toUpperCase()}-ZZZZZZZ`);
    // A later write sorts after an earlier one, which is what makes the stamp worth carrying.
    expect(contentId(at + 1000, () => 0) > id).toBe(true);
  });
});

describe('the rebuilt sheet', () => {
  it('changes only the ID column', () => {
    const original = buildProductCatalogRows({
      settings: record.settings,
      sourceLink: record.sourceLink,
      videoLink: record.videoLink,
      count: record.productCount,
      newId: () => 'ORIGINAL'
    });
    const updated = rebuildCatalogRows({ record, newId: () => 'UPDATED' });
    expect(updated).toHaveLength(original.length);
    expect(updated.slice(0, 2)).toEqual(original.slice(0, 2));
    updated.slice(2).forEach((row, index) => {
      row.forEach((cell, column) => {
        if (column === CATALOG_UPDATER_COLUMNS.id) {
          expect(cell).toEqual({ t: 'string', v: 'UPDATED' });
        } else {
          expect(cell).toEqual(original[index + 2]![column]);
        }
      });
    });
  });

  it('points every row at a re-stitched copy when one is given, still distinct per row', () => {
    const copy = 'https://drive.google.com/file/d/copy/view?usp=sharing';
    const rows = rebuildCatalogRows({ record, videoLinkOverride: copy });
    const links = rows.slice(2).map(row => row[CATALOG_UPDATER_COLUMNS.video]!.v);
    expect(links[0]).toBe(`${copy}?v=001`);
    expect(links[99]).toBe(`${copy}?v=100`);
    expect(new Set(links).size).toBe(100);
  });
});

describe('intervals and retries', () => {
  it('accepts one hour, one day and one week', () => {
    expect(['1h', '1d', '1w'].map(parseUpdaterInterval)).toEqual(['1h', '1d', '1w']);
    for (const bad of ['1m', '', 3600, null]) expect(parseUpdaterInterval(bad)).toBeNull();
  });

  it('backs off 1, 5, then 15 minutes', () => {
    expect([1, 2, 3, 7].map(retryDelaySeconds)).toEqual([60, 300, 900, 900]);
  });
});

describe('the updater interval', () => {
  it('takes the presets and whole hours from 1 to 720', () => {
    expect(updaterIntervalSeconds(parseUpdaterInterval('1w')!)).toBe(604_800);
    expect(updaterIntervalSeconds(parseUpdaterInterval('6h')!)).toBe(21_600);
    expect(parseUpdaterInterval('720h')).toBe('720h');
    for (const bad of ['0h', '721h', '06h', '1.5h', '2d', '', null]) {
      expect(parseUpdaterInterval(bad)).toBeNull();
    }
  });

  it('reads what a person types in the hours field', () => {
    expect(customIntervalFromHours(' 6 ')).toBe('6h');
    expect(customIntervalFromHours('024')).toBe('24h');
    for (const bad of ['0', '721', '1.5', '-3', '', 'шість']) {
      expect(customIntervalFromHours(bad)).toBeNull();
    }
  });
});
