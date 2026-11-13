import { describe, expect, it, vi } from 'vitest';
import {
  planAutomaticUpdateRows,
  parseCatalogUpdateContentContext,
  runCatalogUpdaterTick,
  type CatalogUpdaterDeps,
  type ClaimedCatalog,
  type CatalogUpdateContentRecipe
} from '../supabase/functions/catalog-updater/worker';
import { globalImageFixture } from './fixtures/catalog-global';
const manual = {
  title: 'Black Hoodie Custom',
  description: 'My black hoodie description',
  price: 97,
  imageLink: 'https://image.invalid/old',
  material: 'manual material',
  size: 'XL'
};
const item: ClaimedCatalog = {
  catalogId: 'catalog',
  teamId: 'team',
  imageAttemptId: 'attempt',
  attempts: 1,
  updateCount: 0,
  productCount: 1,
  sourceLink: 'https://offer.invalid',
  videoLink: 'https://video.invalid',
  settings: manual,
  rows: [manual],
  refreshTexts: false,
  refreshImages: false,
  growProducts: true,
  driveFileId: 'sheet',
  resourceKey: null,
  credentialId: 'credential',
  currentVideoLink: null,
  spare: null
};
const share = vi.fn(async () => undefined);
const deps = (extra: Partial<CatalogUpdaterDeps> = {}) => ({ ...extra }) as CatalogUpdaterDeps;
describe('automatic updater content', () => {
  it('generates growth rows even with both refresh flags off, retaining manual values', async () => {
    const image = globalImageFixture();
    const drawImages = vi.fn<NonNullable<CatalogUpdaterDeps['drawImages']>>(async () => [image]);
    const drawTexts = vi.fn();
    const recipe = await planAutomaticUpdateRows(deps({ drawImages, drawTexts }), item, share, 2);
    expect(recipe).toMatchObject({ productCount: 2, automaticRowCount: 1, retainedRowCount: 1 });
    expect(recipe.rows[0]).toEqual(manual);
    expect(recipe.rows[1]).toMatchObject({
      pictureImage: image,
      contentPolicyVersion: 1,
      material: '',
      size: ''
    });
    expect(drawTexts).not.toHaveBeenCalled();
    expect(drawImages.mock.calls[0]?.[2]).toMatchObject({ scope: 'growth', attemptId: 'attempt' });
  });
  it('generates fresh text against retained images and ignores the old space price range', async () => {
    const image = globalImageFixture();
    const original = { ...manual, imageLink: image.publicUrl, pictureImage: image };
    const drawImages = vi.fn();
    const recipe = await planAutomaticUpdateRows(
      deps({ drawImages }),
      { ...item, refreshTexts: true, rows: [original], priceRange: { min: 9999, max: 9999 } },
      share,
      1
    );
    expect(recipe.rows[0]).toMatchObject({
      imageLink: image.publicUrl,
      pictureImage: image,
      contentPolicyVersion: 1
    });
    expect(recipe.rows[0]!.price).toBeLessThanOrEqual(55);
    expect(drawImages).not.toHaveBeenCalled();
  });
  it('constrains retained global text but leaves growth images unconstrained', async () => {
    const drawImages = vi.fn<NonNullable<CatalogUpdaterDeps['drawImages']>>(async () => [
      globalImageFixture(1),
      globalImageFixture(2)
    ]);
    const recipe = await planAutomaticUpdateRows(
      deps({ drawImages }),
      { ...item, globalImages: true },
      share,
      2
    );
    expect(drawImages.mock.calls[0]?.[2]).toMatchObject({
      pairs: [{ garment: 'Hoodie', color: 'black' }, null]
    });
    expect(recipe.rows[0]).toMatchObject({
      title: manual.title,
      description: manual.description,
      price: manual.price,
      material: manual.material,
      size: manual.size
    });
    expect(recipe.rows[0]!.imageLink).toBe(globalImageFixture(1).publicUrl);
    expect(recipe.automaticRowCount).toBe(1);
  });
  it('refuses a conflicting final image instead of rewriting retained manual text', async () => {
    const image = globalImageFixture();
    image.classification = {
      ...image.classification,
      mode: 'matched',
      garment: 'Wrap Dress',
      color: 'coral'
    };
    await expect(
      planAutomaticUpdateRows(
        deps({ drawImages: async () => [image] }),
        { ...item, globalImages: true },
        share,
        1
      )
    ).rejects.toMatchObject({ code: 'IMAGE_TEXT_PAIRING_CONFLICT' });
  });
  it('keeps previously automatic retained rows out of the newly-generated receipt count', async () => {
    const old = { ...manual, contentPolicyVersion: 1 as const, contentVariantId: 25 };
    const recipe = await planAutomaticUpdateRows(deps(), { ...item, rows: [old] }, share, 1);
    expect(recipe).toMatchObject({ automaticRowCount: 0, retainedRowCount: 1, rows: [old] });
  });
  it('refuses invalid frozen counts and unsupported versions', () => {
    const context = {
      attemptId: 'attempt',
      baseSignature: 'base',
      recipe: {
        contentPolicyVersion: 1,
        productCount: 1,
        automaticRowCount: 0,
        retainedRowCount: 1,
        rows: [manual]
      }
    };
    expect(parseCatalogUpdateContentContext(context)).toEqual(context);
    expect(() =>
      parseCatalogUpdateContentContext({
        ...context,
        recipe: { ...context.recipe, automaticRowCount: 1 }
      })
    ).toThrow();
    expect(() =>
      parseCatalogUpdateContentContext({
        ...context,
        recipe: { ...context.recipe, contentPolicyVersion: 2 }
      })
    ).toThrow();
  });
  it('restores frozen content before all draws and survives an unknown provider write without rerolling', async () => {
    const recipe: CatalogUpdateContentRecipe = {
      contentPolicyVersion: 1,
      productCount: 1,
      automaticRowCount: 0,
      retainedRowCount: 1,
      rows: [manual]
    };
    const raw = {
      catalog_material_id: 'catalog',
      team_id: 'team',
      attempts: 1,
      update_count: 0,
      product_count: 1,
      source_link: item.sourceLink,
      video_link: item.videoLink,
      settings_snapshot: manual,
      drive_file_id: 'sheet',
      credential_id: 'credential',
      grow_products: true
    };
    const drawImages = vi.fn(),
      drawTexts = vi.fn(),
      readImageLink = vi.fn(),
      freezeContentRecipe = vi.fn();
    const beginWrite = vi.fn<CatalogUpdaterDeps['beginWrite']>(async () => true),
      unknown = vi.fn(async () => true);
    const complete = vi.fn(async () => true);
    let failUpload = true,
      marker: Record<string, string> = {};
    const drive = {
      getFile: vi.fn(async () => ({
        id: 'sheet',
        version: '1',
        trashed: false,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        appProperties: marker
      })),
      updateConvertedFile: vi.fn(async (input: { appProperties: Record<string, string> }) => {
        if (failUpload) throw new Error('lost reply');
        marker = input.appProperties;
      })
    };
    const make = () => {
      let claimed = false;
      return deps({
        workerId: 'worker',
        openRounds: async () => 1,
        claim: async () => (claimed ? [] : ((claimed = true), [raw])),
        readContentRecipe: async () => ({ attemptId: 'attempt', baseSignature: 'base', recipe }),
        drawImages,
        drawTexts,
        readImageLink,
        freezeContentRecipe,
        driveFor: async () => drive as never,
        progress: async () => true,
        beginWrite,
        unknown,
        retry: vi.fn(async () => true),
        recordChanges: async () => true,
        complete,
        finishWrite: async () => true,
        claimRetired: async () => [],
        now: () => 0,
        log: vi.fn()
      });
    };
    expect((await runCatalogUpdaterTick(make(), { budgetMs: 1000 })).failed).toBe(1);
    expect(unknown).toHaveBeenCalled();
    failUpload = false;
    expect((await runCatalogUpdaterTick(make(), { budgetMs: 1000 })).updated).toBe(1);
    expect(drawImages).not.toHaveBeenCalled();
    expect(drawTexts).not.toHaveBeenCalled();
    expect(readImageLink).not.toHaveBeenCalled();
    expect(freezeContentRecipe).not.toHaveBeenCalled();
    expect(beginWrite.mock.calls.map(call => (call[1] as { became: unknown }).became)).toEqual([
      expect.objectContaining({
        productCount: 1,
        snapshot: expect.objectContaining({ rows: [manual] })
      }),
      expect.objectContaining({
        productCount: 1,
        snapshot: expect.objectContaining({ rows: [manual] })
      })
    ]);
  });
});
