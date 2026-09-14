import { crc32 as nodeCrc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_CATALOG_SHEET_NAME,
  buildProductCatalogRows
} from '../supabase/functions/_shared/product-catalog.js';
import { buildXlsx, columnName, crc32, xmlText } from '../supabase/functions/_shared/xlsx.js';

/**
 * Feature 022: the workbook Drive converts into the catalog sheet.
 *
 * Read back with a real ZIP reader rather than with our own parser, so a mistake in the writer
 * cannot be mirrored by the same mistake in the test.
 */

function unzip(bytes: Uint8Array): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) return reject(error);
        const files = new Map<string, string>();
        zip.readEntry();
        zip.on('entry', entry => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return reject(streamError);
            const chunks: Buffer[] = [];
            stream.on('data', chunk => chunks.push(chunk as Buffer));
            stream.on('end', () => {
              const data = Buffer.concat(chunks);
              // yauzl validates sizes; the CRC is checked here against Node's own implementation.
              if (nodeCrc32(data) !== entry.crc32)
                reject(new Error(`bad CRC for ${entry.fileName}`));
              files.set(entry.fileName, data.toString('utf8'));
              zip.readEntry();
            });
          });
        });
        zip.on('end', () => resolve(files));
        zip.on('error', reject);
      }
    );
  });
}

const settings = {
  title: 'Polo',
  description: 'Knit',
  price: 10,
  imageLink: 'https://drive.google.com/file/d/img/view?usp=sharing'
};

describe('the workbook', () => {
  it('has every part a spreadsheet needs, under valid CRCs', async () => {
    const rows = buildProductCatalogRows({
      settings,
      sourceLink: 'https://a.test/?x=1',
      videoLink: 'https://drive.google.com/file/d/v/view?usp=sharing',
      count: 3
    });
    const files = await unzip(buildXlsx({ sheetName: PRODUCT_CATALOG_SHEET_NAME, rows }));
    expect([...files.keys()].sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/_rels/workbook.xml.rels',
        'xl/sharedStrings.xml',
        'xl/styles.xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml'
      ].sort()
    );
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="catalog_products"');
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="A3"><v>1</v></c>');
    expect(sheet).toContain('<c r="L3"><v>75</v></c>');
    expect(sheet).toMatch(/<c r="AB3" t="s"><v>\d+<\/v><\/c>/u);
    expect(sheet).not.toContain('<f');
    expect(sheet).not.toContain('r="O3"'); // an empty value is no cell at all
  });

  it('keeps what a person typed as text, never as a formula', async () => {
    const hostile = '=HYPERLINK("https://example.com","x")';
    const rows = buildProductCatalogRows({
      settings: { ...settings, title: '-dash', description: hostile },
      sourceLink: 'https://a.test/?a=1&b=<2>',
      videoLink: 'https://drive.google.com/file/d/v/view?usp=sharing',
      count: 2
    });
    const files = await unzip(buildXlsx({ sheetName: PRODUCT_CATALOG_SHEET_NAME, rows }));
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    const strings = files.get('xl/sharedStrings.xml')!;
    expect(sheet).not.toContain('<f');
    expect(sheet).toMatch(/<c r="C3" t="s">/u);
    expect(strings).toContain(xmlText(hostile));
    expect(strings).toContain('<t>-dash</t>');
    expect(strings).toContain('https://a.test/?a=1&amp;b=&lt;2&gt;');
    // Shared strings are counted once each: two products share the same title.
    expect(strings.match(/<t>-dash<\/t>/gu)).toHaveLength(1);
  });

  it('preserves leading spaces and drops characters XML cannot hold', async () => {
    const files = await unzip(
      buildXlsx({
        sheetName: 'x',
        rows: [
          [
            { t: 'string', v: ' Lightweight' },
            { t: 'string', v: 'a\u0001b' }
          ]
        ]
      })
    );
    const strings = files.get('xl/sharedStrings.xml')!;
    expect(strings).toContain('<t xml:space="preserve"> Lightweight</t>');
    expect(strings).toContain('<t>ab</t>');
  });

  it('stays small at 400 products with a description at its limit', () => {
    const rows = buildProductCatalogRows({
      settings: { ...settings, description: 'd'.repeat(9999) },
      sourceLink: `https://a.test/?${'q'.repeat(2000)}`,
      videoLink: 'https://drive.google.com/file/d/v/view?usp=sharing',
      count: 400
    });
    const bytes = buildXlsx({ sheetName: PRODUCT_CATALOG_SHEET_NAME, rows });
    expect(bytes.byteLength).toBeLessThan(1024 * 1024);
  });

  it('refuses a sheet name a workbook cannot have', () => {
    expect(() => buildXlsx({ sheetName: 'a/b', rows: [] })).toThrow(RangeError);
    expect(() => buildXlsx({ sheetName: 'x'.repeat(32), rows: [] })).toThrow(RangeError);
  });
});

describe('the pieces', () => {
  it('computes the same CRC-32 as zlib', () => {
    const data = new TextEncoder().encode('catalog_products — Каталог');
    expect(crc32(data)).toBe(nodeCrc32(Buffer.from(data)));
  });

  it('names columns past Z', () => {
    expect([0, 25, 26, 30, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AE', 'ZZ', 'AAA']);
  });
});
