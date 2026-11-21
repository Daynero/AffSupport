/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import {
  launchCreativeSourceLinks,
  type LaunchConfig,
  type LaunchCreative
} from '../packages/shared/src/team/launches';
import {
  PRODUCT_CATALOG_TEMPLATE,
  buildProductCatalogRows,
  catalogCreativeCells,
  parseCatalogCreativeLayout
} from '../supabase/functions/_shared/product-catalog.js';
import { rebuildCatalogRows } from '../supabase/functions/_shared/catalog-updater.js';
import { launchConfig, launchSources } from './fixtures/launches';

/*
 * Owner, 2026-11-21: «кожен блок — свій креатив». In a catalog of several creatives every
 * block's product link carries SUB «Креатив» of the creative that block shows, so the tracker
 * credits the video a buyer actually saw — and every later update keeps it so.
 */

const video = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
const creative = (n: number, copies: number): LaunchCreative => ({
  materialId: video(n),
  alias: `creo_${n}`,
  copies,
  pinned: null
});
const sources = {
  ...launchSources,
  materialType: 'video',
  materials: [1, 2, 3].map(n => ({ materialId: video(n), type: 'video', version: '1' }))
};
const multi = (creatives: LaunchCreative[], sub3: string[] = ['creative']): LaunchConfig =>
  launchConfig({
    method: 'catalog',
    originalUrl: 'https://offer.example.test/?sub1=a&sub2=b&sub3=c',
    materialId: creatives[0]!.materialId,
    creativeAlias: creatives[0]!.alias,
    creativeKind: 'video',
    creatives,
    subConfig: { schemaVersion: 1, sub1: ['buyer'], sub2: [], sub3 },
    catalog: {
      productCount: creatives.reduce((sum, c) => sum + c.copies, 0),
      restitchEnabled: false,
      finalDurationMode: 'random-30-40',
      customFinalDurationSeconds: null
    }
  });
const sub3 = (link: string) => new URL(link).searchParams.get('sub3');

describe('launchCreativeSourceLinks', () => {
  it('gives every creative a link whose SUB «Креатив» is its own', () => {
    const links = launchCreativeSourceLinks(
      multi([creative(1, 2), creative(2, 2), creative(3, 1)]),
      sources
    );
    expect(links?.map(sub3)).toEqual(['creo_1', 'creo_2', 'creo_3']);
    // Everything else in the link is the same for every block.
    expect(new Set(links!.map(link => new URL(link).searchParams.get('sub1'))).size).toBe(1);
  });

  it('keeps the single link when nothing tells the blocks apart', () => {
    expect(launchCreativeSourceLinks(multi([creative(1, 5)]), sources)).toBeNull();
    expect(
      launchCreativeSourceLinks(multi([creative(1, 2), creative(2, 3)], []), sources)
    ).toBeNull();
  });
});

const column = (key: string) => PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.key === key);
const LINK = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.source.kind === 'sourceLink');
const settings = {
  title: 'Polo',
  description: 'Knit',
  price: 10,
  imageLink: 'https://i.test/w.png'
};
const links = (rows: { v: string | number }[][]) => rows.slice(2).map(row => String(row[LINK]!.v));

describe('catalog rows', () => {
  it('writes each block’s own product link, and the single link where a block has none', () => {
    expect(column('link')).toBe(LINK);
    const rows = buildProductCatalogRows({
      settings,
      sourceLink: 'https://offer.test/?sub3=creo_1',
      videoLink: 'https://drive.google.com/file/d/A/view',
      count: 4,
      creatives: [
        { idPrefix: 'A', kind: 'video', sourceLink: 'https://offer.test/?sub3=creo_1' },
        { idPrefix: 'B', kind: 'video', sourceLink: 'https://offer.test/?sub3=creo_2' },
        { idPrefix: 'C', kind: 'video' }
      ],
      rowCreatives: [0, 1, 1, 2]
    });
    expect(links(rows)).toEqual([
      'https://offer.test/?sub3=creo_1',
      'https://offer.test/?sub3=creo_2',
      'https://offer.test/?sub3=creo_2',
      'https://offer.test/?sub3=creo_1'
    ]);
  });

  it('keeps the block links through the snapshot and every later update', () => {
    const snapshot = {
      _catalogCreativeKind: 'video',
      _catalogCreatives: [
        {
          ordinal: 0,
          materialId: video(1),
          alias: 'creo_1',
          kind: 'video',
          sourceLink: 'https://offer.test/?sub3=creo_1'
        },
        {
          ordinal: 1,
          materialId: video(2),
          alias: 'creo_2',
          kind: 'video',
          sourceLink: 'https://offer.test/?sub3=creo_2'
        }
      ],
      _catalogRowCreatives: [0, 0, 1]
    };
    const layout = parseCatalogCreativeLayout(snapshot, 3)!;
    expect(catalogCreativeCells(layout).map(cells => cells.sourceLink)).toEqual([
      'https://offer.test/?sub3=creo_1',
      'https://offer.test/?sub3=creo_2'
    ]);
    const rows = rebuildCatalogRows({
      record: {
        settings,
        sourceLink: 'https://offer.test/?sub3=creo_1',
        videoLink: 'https://drive.google.com/file/d/A/view',
        productCount: 3,
        creatives: layout
      }
    });
    expect(links(rows)).toEqual([
      'https://offer.test/?sub3=creo_1',
      'https://offer.test/?sub3=creo_1',
      'https://offer.test/?sub3=creo_2'
    ]);
  });

  it('refuses a block link that is not a web link', () => {
    expect(() =>
      parseCatalogCreativeLayout(
        {
          _catalogCreativeKind: 'video',
          _catalogCreatives: [
            {
              ordinal: 0,
              materialId: video(1),
              alias: 'a',
              kind: 'video',
              sourceLink: 'javascript:x'
            }
          ],
          _catalogRowCreatives: [0]
        },
        1
      )
    ).toThrow('INVALID_CATALOG_CREATIVES');
  });
});
