import { describe, expect, it } from 'vitest';
import {
  CATALOG_ID_PREFIX_MAX,
  catalogIdPrefix,
  catalogProductId,
  contentId,
  transliterateName
} from '../supabase/functions/_shared/product-details.js';
import { CATALOG_ID_PREFIX_MAX as SHARED_PREFIX_MAX } from '../packages/shared/src/team/launches.js';
import { launchCreativeIdPrefix } from '../packages/shared/src/team/launches/naming.js';

/**
 * 062 (contracts/catalog-rows.md): every product of a new catalog carries the creative it shows
 * in its ID — `<prefix>-<contentId>` — so the owner can tell in Meta which video a product is.
 */
const NEW_ID = /^[A-Za-z0-9_-]{1,40}-[0-9A-Z]+-[0-9A-Z]{7}$/u;
const OLD_ID = /^[0-9A-Z]+-[0-9A-Z]{7}$/u;

describe('catalogIdPrefix', () => {
  it('keeps a Launch alias as it is, cut to forty characters', () => {
    expect(catalogIdPrefix('IN40')).toBe('IN40');
    expect(catalogIdPrefix('hoodie_black-01')).toBe('hoodie_black-01');
    expect(catalogIdPrefix('a'.repeat(160))).toBe('a'.repeat(CATALOG_ID_PREFIX_MAX));
    expect(CATALOG_ID_PREFIX_MAX).toBe(SHARED_PREFIX_MAX);
  });

  it('agrees with the shared preview prefix for every alias', () => {
    for (const alias of ['IN40', 'x', 'A_b-C', 'z'.repeat(41), 'Mixed_Case-123'])
      expect(catalogIdPrefix(alias)).toBe(launchCreativeIdPrefix(alias));
  });

  it('turns an explorer video name into a Latin prefix', () => {
    expect(catalogIdPrefix('IN 40.mp4')).toBe('IN_40');
    expect(catalogIdPrefix('Відео Щастя.mov')).toBe('Video_Shchastia');
    expect(catalogIdPrefix('Згода — їжак.mp4')).toBe('Zghoda_yizhak');
    expect(catalogIdPrefix('Юля   і  Яна.mp4')).toBe('Yulia_i_Yana');
    expect(catalogIdPrefix('Café déjà vu.mp4')).toBe('Cafe_deja_vu');
    expect(catalogIdPrefix('__--ролик--__.mp4')).toBe('rolyk');
  });

  it('never returns an empty prefix', () => {
    expect(catalogIdPrefix('.mp4')).toBe('creative');
    expect(catalogIdPrefix('!!!.mov')).toBe('creative');
    expect(catalogIdPrefix('')).toBe('creative');
  });

  it('only ever spells what an ID may hold', () => {
    for (const name of ['Відео №1 (фінал).mp4', 'a/b\\c.mp4', 'emoji 🎬 clip.mp4', 'Ґанок’s.mp4'])
      expect(catalogIdPrefix(name)).toMatch(/^[A-Za-z0-9_-]{1,40}$/u);
  });

  it('transliterates word starts the national way', () => {
    expect(transliterateName('Євген Їжак Йосип')).toBe('Yevhen Yizhak Yosyp');
    expect(transliterateName('Маєток')).toBe('Maietok');
  });
});

describe('catalogProductId', () => {
  it('puts the prefix before a fresh content ID', () => {
    const id = catalogProductId('IN40', contentId());
    expect(id).toMatch(NEW_ID);
    expect(id.startsWith('IN40-')).toBe(true);
  });

  it('keeps the bare ID for a catalog from before 062', () => {
    expect(catalogProductId(null, contentId())).toMatch(OLD_ID);
  });

  it('stays within Meta’s hundred characters', () => {
    expect(catalogProductId('p'.repeat(200), contentId()).length).toBeLessThanOrEqual(100);
    expect(catalogProductId('p'.repeat(200), contentId())).toMatch(NEW_ID);
  });
});
