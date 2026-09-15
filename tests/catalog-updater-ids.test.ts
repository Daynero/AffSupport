import { describe, expect, it } from 'vitest';
import { customIntervalFromHours } from '../apps/web/src/team/catalog-updater/limits.js';
import {
  CATALOG_UPDATER_COLUMNS,
  idOffset,
  parseUpdaterInterval,
  updaterIntervalSeconds,
  rebuildCatalogRows,
  retryDelaySeconds
} from '../supabase/functions/_shared/catalog-updater.js';
import { buildProductCatalogRows } from '../supabase/functions/_shared/product-catalog.js';

/**
 * Feature 023: how an update moves a catalog on. The owner's rule is +500, +501, +502… per update;
 * what matters is that no ID ever comes back and that nothing else in the sheet moves.
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
  rows.slice(2).map(row => row[CATALOG_UPDATER_COLUMNS.id]!.v as number);

describe('the ID rule', () => {
  it('steps by 500, then 501, then 502', () => {
    expect([0, 1, 2, 3].map(idOffset)).toEqual([0, 500, 1001, 1503]);
  });

  it('moves a 100-product sheet the way the owner described', () => {
    const range = (k: number) => {
      const shifted = ids(rebuildCatalogRows({ record, updateCount: k }));
      return [shifted[0], shifted[shifted.length - 1]];
    };
    expect(range(0)).toEqual([1, 100]);
    expect(range(1)).toEqual([501, 600]);
    expect(range(2)).toEqual([1002, 1101]);
    expect(range(3)).toEqual([1504, 1603]);
  });

  it('never repeats an ID over 2000 updates of a 400-product sheet', () => {
    const seen = new Set<number>();
    let written = 0;
    for (let k = 0; k <= 2000; k += 1) {
      const offset = idOffset(k);
      for (let row = 1; row <= 400; row += 1) {
        seen.add(row + offset);
        written += 1;
      }
    }
    // One assertion, not 800 000: a repeat would make the set smaller than what was written.
    expect(seen.size).toBe(written);
  });

  it('refuses a count that is not a non-negative integer', () => {
    expect(() => idOffset(-1)).toThrow(RangeError);
    expect(() => idOffset(1.5)).toThrow(RangeError);
  });
});

describe('the rebuilt sheet', () => {
  it('changes only the ID column', () => {
    const original = buildProductCatalogRows({
      settings: record.settings,
      sourceLink: record.sourceLink,
      videoLink: record.videoLink,
      count: record.productCount
    });
    const updated = rebuildCatalogRows({ record, updateCount: 4 });
    expect(updated).toHaveLength(original.length);
    expect(updated.slice(0, 2)).toEqual(original.slice(0, 2));
    updated.slice(2).forEach((row, index) => {
      row.forEach((cell, column) => {
        if (column === CATALOG_UPDATER_COLUMNS.id) {
          expect(cell).toEqual({ t: 'number', v: index + 1 + idOffset(4) });
        } else {
          expect(cell).toEqual(original[index + 2]![column]);
        }
      });
    });
  });

  it('points every row at a re-stitched copy when one is given, still distinct per row', () => {
    const copy = 'https://drive.google.com/file/d/copy/view?usp=sharing';
    const rows = rebuildCatalogRows({ record, updateCount: 1, videoLinkOverride: copy });
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
