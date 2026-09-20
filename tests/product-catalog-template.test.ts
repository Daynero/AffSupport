import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_CATALOG_HEADER_ROWS,
  PRODUCT_CATALOG_TEMPLATE,
  PRODUCT_COUNT_DEFAULT,
  SOURCE_LINK_MAX,
  buildProductCatalogRows,
  formatPrice,
  parseProductCount,
  parseWebLink,
  productCatalogName,
  videoShareLink,
  type Cell
} from '../supabase/functions/_shared/product-catalog.js';

/**
 * Feature 022: the owner's Meta catalog template and the rows a sheet is built from.
 *
 * The contract in `specs/022-video-catalog-sheet/contracts/catalog-template.json` was extracted
 * from the owner's example file, so the embedded template is checked against it cell by cell —
 * a retyped header would drift the first time someone "tidied" a Russian sentence.
 */

interface ContractColumn {
  column: string;
  key: string;
  description: string;
  source:
    | { kind: 'rowNumber' | 'dialogLink' | 'videoLink' }
    | { kind: 'spaceSetting'; setting: string; format?: string }
    | { kind: 'copyOf'; column: string }
    | { kind: 'fixed'; value: string | number; cellType: 'text' | 'number' };
}

const contract = JSON.parse(
  readFileSync('specs/022-video-catalog-sheet/contracts/catalog-template.json', 'utf8')
) as { sheetName: string; headerRows: number; columns: ContractColumn[] };

const settings = {
  title: "Essentials Men's Polo",
  description: ' Lightweight Wool Blend Knit',
  price: 10,
  imageLink: 'https://drive.google.com/file/d/img/view?usp=sharing'
};
const videoLink = 'https://drive.google.com/file/d/vid/view?usp=sharing';
const sourceLink = 'https://offer.example.test/?sub_1=a&fb_ad_id={{ad.id}}';

function cellAt(rows: Cell[][], column: string, row: number): Cell {
  const index = PRODUCT_CATALOG_TEMPLATE.findIndex(entry => entry.column === column);
  return rows[row - 1]![index]!;
}

describe('the embedded template matches the owner’s example', () => {
  it('has the same 31 columns, keys and header descriptions', () => {
    expect(PRODUCT_CATALOG_TEMPLATE).toHaveLength(31);
    expect(contract.headerRows).toBe(PRODUCT_CATALOG_HEADER_ROWS);
    PRODUCT_CATALOG_TEMPLATE.forEach((column, index) => {
      const expected = contract.columns[index]!;
      expect(column.column).toBe(expected.column);
      expect(column.key).toBe(expected.key);
      expect(column.description).toBe(expected.description);
    });
  });

  it('fills every column from the source the contract gives it', () => {
    PRODUCT_CATALOG_TEMPLATE.forEach((column, index) => {
      const expected = contract.columns[index]!.source;
      const actual = column.source;
      switch (expected.kind) {
        case 'rowNumber':
          expect(actual.kind).toBe('rowNumber');
          break;
        case 'dialogLink':
          expect(actual.kind).toBe('sourceLink');
          break;
        case 'videoLink':
          expect(actual.kind).toBe('videoLink');
          break;
        case 'spaceSetting':
          expect(actual).toEqual({ kind: 'setting', setting: expected.setting });
          break;
        case 'copyOf':
          expect(actual).toEqual({ kind: 'copyOf', column: expected.column });
          break;
        case 'fixed':
          expect(actual).toEqual({
            kind: 'fixed',
            cell:
              expected.cellType === 'number'
                ? { t: 'number', v: expected.value }
                : { t: 'string', v: expected.value }
          });
          break;
      }
    });
  });
});

describe('the rows of a catalog', () => {
  const rows = buildProductCatalogRows({ settings, sourceLink, videoLink, count: 400 });

  it('is two header rows and one row per product', () => {
    expect(rows).toHaveLength(402);
    expect(rows[0]!.map(cell => cell.v)).toEqual(contract.columns.map(c => c.description));
    expect(rows[1]!.map(cell => cell.v)).toEqual(contract.columns.map(c => c.key));
    expect(rows.every(row => row.length === 31)).toBe(true);
  });

  it('numbers the products from 1 and gives each its own video link', () => {
    expect(cellAt(rows, 'A', 3)).toEqual({ t: 'number', v: 1 });
    expect(cellAt(rows, 'A', 402)).toEqual({ t: 'number', v: 400 });
    expect(cellAt(rows, 'Z', 3)).toEqual({ t: 'string', v: `${videoLink}?v=001` });
    expect(cellAt(rows, 'Z', 12)).toEqual({ t: 'string', v: `${videoLink}?v=010` });
    expect(cellAt(rows, 'Z', 402)).toEqual({ t: 'string', v: `${videoLink}?v=400` });
    const links = new Set(rows.slice(2).map(row => cellAt([row], 'Z', 1).v));
    expect(links.size).toBe(400);
  });

  it('repeats the space’s values and the pasted link on every product', () => {
    for (const row of [3, 200, 402]) {
      expect(cellAt(rows, 'B', row).v).toBe(settings.title);
      expect(cellAt(rows, 'C', row).v).toBe(settings.description);
      expect(cellAt(rows, 'F', row)).toEqual({ t: 'string', v: '10,00 USD' });
      expect(cellAt(rows, 'M', row)).toEqual(cellAt(rows, 'F', row));
      expect(cellAt(rows, 'G', row).v).toBe(sourceLink);
      expect(cellAt(rows, 'H', row).v).toBe(settings.imageLink);
    }
  });

  it('keeps the fixed values, with gtin as text and the quantity as a number', () => {
    expect(cellAt(rows, 'D', 3).v).toBe('in stock');
    expect(cellAt(rows, 'I', 3).v).toBe('Facebook');
    expect(cellAt(rows, 'L', 3)).toEqual({ t: 'number', v: 75 });
    expect(cellAt(rows, 'N', 3).v).toBe('2020-04-30T09:30-08:00/2020-05-30T23:59-08:00');
    expect(cellAt(rows, 'O', 3).v).toBe('');
    expect(cellAt(rows, 'AB', 3)).toEqual({ t: 'string', v: '8806088573892' });
    expect(cellAt(rows, 'AE', 3).v).toBe('Bodycon');
  });
});

describe('what a person can type', () => {
  it.each([
    [1, 1],
    ['1', 1],
    ['007', 7],
    [' 12 ', 12],
    ['400', 400],
    [String(PRODUCT_COUNT_DEFAULT), 100]
  ])('accepts the count %j', (input, expected) => {
    expect(parseProductCount(input)).toEqual({ ok: true, value: expected });
  });

  it.each([0, '0', '401', 401, '-1', -1, '2.5', 2.5, 'abc', '', '1000', null, undefined])(
    'refuses the count %j',
    input => {
      expect(parseProductCount(input)).toEqual({ ok: false, error: 'count' });
    }
  );

  it('accepts http and https links, trimmed', () => {
    expect(parseWebLink(' https://a.test/x?y=1 ', SOURCE_LINK_MAX)).toEqual({
      ok: true,
      value: 'https://a.test/x?y=1'
    });
    expect(parseWebLink('http://a.test', SOURCE_LINK_MAX).ok).toBe(true);
  });

  it.each(['ftp://a.test', 'https://a b.test', 'a.test', 'javascript:alert(1)', '', 42])(
    'refuses the link %j',
    input => {
      expect(parseWebLink(input, SOURCE_LINK_MAX)).toEqual({ ok: false, error: 'link' });
    }
  );

  it('refuses a link past its limit', () => {
    expect(parseWebLink(`https://a.test/${'x'.repeat(100)}`, 50).ok).toBe(false);
  });
});

describe('names and links', () => {
  it('writes the price the owner’s way', () => {
    expect(formatPrice(10)).toBe('10,00 USD');
    expect(formatPrice(999999)).toBe('999999,00 USD');
  });

  it('names a catalog after its video', () => {
    expect(productCatalogName('clip.mp4')).toBe('clip catalog');
    expect(productCatalogName('clip.final.mp4')).toBe('clip.final catalog');
    expect(productCatalogName('no-extension')).toBe('no-extension catalog');
  });

  it('builds the shared link a signed-out viewer can open', () => {
    expect(videoShareLink('abc_123', null)).toBe(
      'https://drive.google.com/file/d/abc_123/view?usp=sharing'
    );
    expect(videoShareLink('abc', '0-key')).toBe(
      'https://drive.google.com/file/d/abc/view?usp=sharing&resourcekey=0-key'
    );
  });
});

describe('the updater leaves 022 alone (023)', () => {
  it('still numbers a fresh catalog from 1 once the updater module is loaded', async () => {
    await import('../supabase/functions/_shared/catalog-updater.js');
    const rows = buildProductCatalogRows({ settings, sourceLink, videoLink, count: 3 });
    expect([3, 4, 5].map(row => cellAt(rows, 'A', row))).toEqual([
      { t: 'number', v: 1 },
      { t: 'number', v: 2 },
      { t: 'number', v: 3 }
    ]);
  });
});
