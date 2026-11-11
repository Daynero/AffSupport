import { describe, expect, it } from 'vitest';
import {
  CATALOG_VIDEO_R2_ERROR_CODES,
  CATALOG_VIDEO_R2_LIMITS,
  CATALOG_VIDEO_R2_REASONS,
  estimateCatalogVideoR2MonthlyUsd,
  isCatalogVideoR2Availability,
  isCatalogVideoR2PreferenceReceipt,
  isCatalogVideoR2PublicUrl,
  isCatalogVideoR2Reason,
  isCatalogVideoR2State,
  isCatalogVideoR2Usage,
  parseCatalogVideoR2WorkerRoute
} from '../packages/shared/src/team/catalog-video-r2';
import { TEAM_ERROR_CODES } from '../packages/shared/src/team/transport';
import { parseLaunchConfig } from '../packages/shared/src/team/launches/validation';
import { parseLaunchDraft } from '../packages/shared/src/team/launches/persistence';
import { launchDefaultValues } from '../packages/shared/src/team/launches/defaults';

const state = {
  catalogMaterialId: 'a3c6e8a4-7d1a-4f2a-9d2a-0f0a1b2c3d4e',
  enabled: true,
  link: 'r2',
  lastSuccessfulUpdateAt: '2026-11-10T08:00:00.000Z',
  copy: { state: 'ready', readyAt: '2026-11-10T07:59:00.000Z', fullHashVerified: true },
  reason: null,
  usedBytes: 100_000_000,
  quotaBytes: CATALOG_VIDEO_R2_LIMITS.teamQuotaBytes,
  canManage: true,
  revision: 3
};

describe('catalog video R2 contract', () => {
  it('registers every feature code on the wire exactly once', () => {
    for (const code of CATALOG_VIDEO_R2_ERROR_CODES) {
      expect((TEAM_ERROR_CODES as readonly string[]).includes(code)).toBe(true);
      expect(TEAM_ERROR_CODES.filter(known => known === code)).toHaveLength(1);
    }
    expect(CATALOG_VIDEO_R2_REASONS).toContain('SOURCE_CHANGED');
    expect(isCatalogVideoR2Reason('PERMISSION_DENIED')).toBe(true);
    expect(isCatalogVideoR2Reason('Provider failed at https://private.example/file')).toBe(false);
  });

  it('accepts the state shape and rejects prose, extra states and unbounded numbers', () => {
    expect(isCatalogVideoR2State(state)).toBe(true);
    expect(
      isCatalogVideoR2State({
        ...state,
        copy: null,
        link: 'drive',
        reason: 'VIDEO_R2_QUOTA_EXCEEDED'
      })
    ).toBe(true);
    expect(isCatalogVideoR2State({ ...state, link: 'gcs' })).toBe(false);
    expect(isCatalogVideoR2State({ ...state, copy: { ...state.copy, state: 'exploded' } })).toBe(
      false
    );
    expect(isCatalogVideoR2State({ ...state, reason: 'something went wrong' })).toBe(false);
    expect(isCatalogVideoR2State({ ...state, usedBytes: -1 })).toBe(false);
    expect(isCatalogVideoR2State({ ...state, lastSuccessfulUpdateAt: 'yesterday' })).toBe(false);
  });

  it('models availability as a discriminated gate', () => {
    expect(
      isCatalogVideoR2Availability({ available: true, canManage: true, contractVersion: 1 })
    ).toBe(true);
    expect(
      isCatalogVideoR2Availability({
        available: false,
        reason: 'VIDEO_R2_POLICY_PENDING',
        canManage: false,
        contractVersion: 1
      })
    ).toBe(true);
    expect(
      isCatalogVideoR2Availability({ available: false, canManage: false, contractVersion: 1 })
    ).toBe(false);
    expect(
      isCatalogVideoR2Availability({
        available: true,
        reason: 'VIDEO_R2_DISABLED',
        canManage: true,
        contractVersion: 1
      })
    ).toBe(false);
    expect(
      isCatalogVideoR2Availability({ available: true, canManage: true, contractVersion: 2 })
    ).toBe(false);
  });

  it('validates receipts, usage and worker routes', () => {
    expect(
      isCatalogVideoR2PreferenceReceipt({
        enabled: true,
        revision: 1,
        updatedAt: '2026-11-10T08:00:00Z'
      })
    ).toBe(true);
    expect(
      isCatalogVideoR2PreferenceReceipt({
        enabled: 'yes',
        revision: 1,
        updatedAt: '2026-11-10T08:00:00Z'
      })
    ).toBe(false);
    expect(
      isCatalogVideoR2Usage({
        usedBytes: 0,
        quotaBytes: 1,
        readyCopies: 0,
        retiringCopies: 0,
        enabledCatalogs: 0
      })
    ).toBe(true);
    expect(isCatalogVideoR2Usage({ usedBytes: 0, quotaBytes: 1, readyCopies: 0 })).toBe(false);
    expect(parseCatalogVideoR2WorkerRoute({ route: 'claim' })).toBe('claim');
    expect(parseCatalogVideoR2WorkerRoute({ route: 'sweep' })).toBe('sweep');
    expect(parseCatalogVideoR2WorkerRoute({ route: 'drop' })).toBeNull();
    expect(parseCatalogVideoR2WorkerRoute('claim')).toBeNull();
  });

  it('accepts only opaque public video URLs', () => {
    const key = 'f'.repeat(32);
    expect(isCatalogVideoR2PublicUrl(`https://videos.example/v/${key}.mp4`)).toBe(true);
    expect(
      isCatalogVideoR2PublicUrl(`https://videos.example/v/${key}.mp4`, 'https://videos.example')
    ).toBe(true);
    expect(
      isCatalogVideoR2PublicUrl(`https://videos.example/v/${key}.mp4`, 'https://other.example')
    ).toBe(false);
    expect(isCatalogVideoR2PublicUrl(`https://videos.example/v/${key}.mp4?token=1`)).toBe(false);
    expect(isCatalogVideoR2PublicUrl(`https://videos.example/v/${key}.mp4#x`)).toBe(false);
    expect(isCatalogVideoR2PublicUrl(`https://user:pw@videos.example/v/${key}.mp4`)).toBe(false);
    expect(isCatalogVideoR2PublicUrl(`http://videos.example/v/${key}.mp4`)).toBe(false);
    expect(isCatalogVideoR2PublicUrl('https://videos.example/team/alice/IN 40.mp4')).toBe(false);
    expect(isCatalogVideoR2PublicUrl(`https://drive.google.com/file/d/abc/view?usp=sharing`)).toBe(
      false
    );
  });

  it('estimates monthly cost as a range and nothing for an empty space', () => {
    expect(estimateCatalogVideoR2MonthlyUsd(0)).toBeNull();
    expect(estimateCatalogVideoR2MonthlyUsd(-5)).toBeNull();
    const estimate = estimateCatalogVideoR2MonthlyUsd(10_000_000_000);
    expect(estimate).toEqual({ low: 0.15, high: 0.18 });
  });

  it('keeps copyVideoToR2 optional and boolean in the Launch catalog configuration', () => {
    const base = {
      schemaVersion: 1,
      agentRowId: 'a3c6e8a4-7d1a-4f2a-9d2a-0f0a1b2c3d41',
      offerId: 'a3c6e8a4-7d1a-4f2a-9d2a-0f0a1b2c3d42',
      buyerId: 'a3c6e8a4-7d1a-4f2a-9d2a-0f0a1b2c3d43',
      materialId: 'a3c6e8a4-7d1a-4f2a-9d2a-0f0a1b2c3d4e',
      creativeAlias: 'alias',
      campaignCount: 1,
      maxBudget: 10,
      adsCount: 1,
      budgetMode: 'auto',
      budgets: null,
      age: 25,
      gender: 'ALL',
      advantagePlus: false,
      launchDate: '2026-11-10',
      timezone: 'Europe/Kyiv',
      method: 'catalog',
      originalUrl: 'https://example.com/',
      subConfig: { schemaVersion: 1, sub1: [], sub2: [], sub3: [] },
      catalog: {
        productCount: 10,
        restitchEnabled: false,
        finalDurationMode: 'random-30-40',
        customFinalDurationSeconds: null
      }
    };
    const absent = parseLaunchConfig(base);
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value.catalog.copyVideoToR2).toBeUndefined();
    const enabled = parseLaunchConfig({
      ...base,
      catalog: { ...base.catalog, copyVideoToR2: true }
    });
    expect(enabled.ok).toBe(true);
    if (enabled.ok) expect(enabled.value.catalog.copyVideoToR2).toBe(true);
    const invalid = parseLaunchConfig({
      ...base,
      catalog: { ...base.catalog, copyVideoToR2: 'yes' }
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors.catalog).toBe('INVALID_INPUT');
  });
});

describe('local edge runtime module graph', () => {
  it('anchors every self-typed shared module the functions import', async () => {
    // The local Supabase CLI mounts only runtime imports; a shared module that
    // names its declaration with @ts-self-types boots as "Module not found"
    // unless the anchor imports that declaration too (found on beta, 050).
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '..');
    const anchor = readFileSync(
      path.join(root, 'supabase/functions/_shared/deno-type-dependencies.ts'),
      'utf8'
    );
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const full = path.join(directory, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(path.join(root, 'supabase/functions'));
    const imported = new Set<string>();
    for (const file of files)
      for (const match of readFileSync(file, 'utf8').matchAll(
        /packages\/shared\/dist\/([\w/-]+)\.js'/gu
      ))
        imported.add(match[1]!);
    const missing = [...imported].filter(name => {
      const source = path.join(root, 'packages/shared/src', `${name}.ts`);
      let text: string;
      try {
        text = readFileSync(source, 'utf8');
      } catch {
        return false;
      }
      return (
        /^\/\/ @ts-self-types=/u.test(text) &&
        !anchor.includes(`packages/shared/dist/${name}.d.ts'`)
      );
    });
    expect(missing).toEqual([]);
  });
});

describe('launch draft round trip', () => {
  const catalog = {
    productCount: 20,
    restitchEnabled: false,
    finalDurationMode: 'random-30-40',
    customFinalDurationSeconds: null
  };
  it('keeps the R2 choice through the saved draft (the box unticked after autosave)', () => {
    expect(
      parseLaunchDraft({ catalog: { ...catalog, copyVideoToR2: true } })?.catalog
    ).toMatchObject({
      copyVideoToR2: true
    });
    expect(
      parseLaunchDraft({ catalog: { ...catalog, copyVideoToR2: false } })?.catalog?.copyVideoToR2
    ).toBe(false);
    expect(parseLaunchDraft({ catalog })?.catalog).not.toHaveProperty('copyVideoToR2');
    expect(parseLaunchDraft({ catalog: { ...catalog, copyVideoToR2: 'yes' } })).toBeNull();
  });
  it('carries the R2 choice into launch defaults', () => {
    const draft = parseLaunchDraft({ catalog: { ...catalog, copyVideoToR2: true } })!;
    expect(launchDefaultValues(draft).catalog).toMatchObject({ copyVideoToR2: true });
  });
});
