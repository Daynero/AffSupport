import { describe, expect, it } from 'vitest';
import {
  addCreatives,
  applyAssistantChange,
  assistantFieldPaths,
  builtinLaunchDraft,
  creativesPatch,
  draftCreatives,
  launchCreativeAlias,
  rescaleCopies,
  type LaunchDraft
} from '@video-compressor/shared';

/**
 * 064 FR-008 / SC-007: for every field the assistant may change, a text change stores what the
 * form stores for the same intent. The «form» side is built from the same helpers LaunchEditor and
 * LaunchCreativePicker call. A field opened to the assistant without a case here fails the last
 * test, so a new field cannot ship without its parity check.
 */
const now = new Date('2026-11-21T10:00:00Z');
const zone = 'Europe/Kyiv';
const base = (): LaunchDraft => builtinLaunchDraft(now, zone);
const M = (n: number) => ({
  materialId: `64600000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  name: `TR_${n}.mp4`,
  kind: 'video' as const
});
const ctx = (refs: Record<string, unknown> = {}) => ({ now, timezone: zone, refs });

function assistant(
  draft: LaunchDraft,
  field: string,
  op: 'set' | 'clear' | 'add' | 'remove' | 'reorder',
  value: unknown,
  refs = {}
) {
  const result = applyAssistantChange(draft, { field, op, value }, ctx(refs));
  if (!result.ok) throw new Error(`${field}: ${result.code}`);
  return result.draft;
}

/** Form: picking materials in the catalog method (LaunchCreativePicker.add). */
function formPick(draft: LaunchDraft, materials: ReturnType<typeof M>[]): LaunchDraft {
  const next = addCreatives(
    draftCreatives(draft),
    materials.map(m => ({ materialId: m.materialId, alias: launchCreativeAlias(m.name) })),
    draft.catalog?.productCount ?? 0
  );
  return {
    ...draft,
    ...creativesPatch(draft, next.creatives, materials[0]!.kind, next.productCount)
  };
}

const CASES: Record<string, () => void> = {
  offerId: () =>
    expect(assistant(base(), 'offerId', 'set', 'ProCaps', { offerId: 'o-1' })).toEqual({
      ...base(),
      offerId: 'o-1'
    }),
  buyerId: () => {
    expect(assistant(base(), 'buyerId', 'set', 'Іра', { buyerId: 'b-1' })).toEqual({
      ...base(),
      buyerId: 'b-1'
    });
    const withBuyer = { ...base(), buyerId: 'b-1' };
    expect(assistant(withBuyer, 'buyerId', 'clear', null)).toEqual(base());
  },
  agentRowId: () =>
    expect(assistant(base(), 'agentRowId', 'set', 'G2', { agentRowId: 'a-2' })).toEqual({
      ...base(),
      agentRowId: 'a-2'
    }),
  creatives: () => {
    const one = assistant(base(), 'creatives', 'set', ['TR 16'], { materials: [M(16)] });
    expect(one).toEqual(formPick(base(), [M(16)]));
    const three = assistant(base(), 'creatives', 'set', ['TR 16', 'TR 18', 'TR 25'], {
      materials: [M(16), M(18), M(25)]
    });
    expect(three).toEqual(formPick(base(), [M(16), M(18), M(25)]));
    const added = assistant(one, 'creatives', 'add', ['TR 18'], { materials: [M(18)] });
    expect(added).toEqual(formPick(one, [M(18)]));
    // The other method keeps one creative in the single shape, as the form does.
    const other = assistant({ ...base(), method: 'other' }, 'creatives', 'set', ['TR 16'], {
      materials: [M(16)]
    });
    expect(other).toMatchObject({
      materialId: M(16).materialId,
      creativeAlias: 'TR_16',
      creatives: undefined
    });
  },
  campaignCount: () => {
    expect(assistant(base(), 'campaignCount', 'set', 5)).toEqual({ ...base(), campaignCount: 5 });
    const manual = {
      ...base(),
      budgetMode: 'manual' as const,
      campaignCount: 3,
      budgets: [10, 20, 30],
      maxBudget: 30
    };
    expect(assistant(manual, 'campaignCount', 'set', 2)).toEqual({
      ...manual,
      campaignCount: 2,
      budgets: [10, 20],
      maxBudget: 20
    });
    expect(assistant(manual, 'campaignCount', 'set', 4)).toEqual({
      ...manual,
      campaignCount: 4,
      budgets: [10, 20, 30, 0]
    });
  },
  adsCount: () =>
    expect(assistant(base(), 'adsCount', 'set', 5)).toEqual({ ...base(), adsCount: 5 }),
  budgetMode: () => {
    // LaunchEditor: changed({ budgetMode: 'single', budgets: null, minBudget: undefined }).
    const withoutMin = base();
    delete withoutMin.minBudget;
    expect(assistant(base(), 'budgetMode', 'set', 'single')).toEqual({
      ...withoutMin,
      budgetMode: 'single',
      budgets: null
    });
  },
  minBudget: () =>
    expect(assistant(base(), 'minBudget', 'set', 15)).toEqual({ ...base(), minBudget: 15 }),
  maxBudget: () =>
    expect(assistant(base(), 'maxBudget', 'set', 20)).toEqual({ ...base(), maxBudget: 20 }),
  budgets: () =>
    expect(assistant({ ...base(), campaignCount: 2 }, 'budgets', 'set', [10, 25])).toEqual({
      ...base(),
      campaignCount: 2,
      budgetMode: 'manual',
      budgets: [10, 25]
    }),
  'catalog.productCount': () => {
    expect(assistant(base(), 'catalog.productCount', 'set', 60)).toEqual({
      ...base(),
      catalog: { ...base().catalog!, productCount: 60 }
    });
    const three = formPick(base(), [M(16), M(18), M(25)]);
    expect(assistant(three, 'catalog.productCount', 'set', 60)).toEqual({
      ...three,
      ...creativesPatch(three, rescaleCopies(draftCreatives(three), 60), 'video', 60)
    });
    expect(
      applyAssistantChange(three, { field: 'catalog.productCount', op: 'set', value: 2 }, ctx())
    ).toEqual({
      ok: false,
      code: 'INVALID_VALUE'
    });
  },
  originalUrl: () => {
    const url = 'https://shop.example/p?x=1';
    expect(assistant(base(), 'originalUrl', 'set', '⟦url:1⟧', { url })).toEqual({
      ...base(),
      originalUrl: url
    });
    expect(assistant({ ...base(), originalUrl: url }, 'originalUrl', 'clear', null)).toEqual(
      base()
    );
  },
  'subConfig.sub1': () =>
    expect(assistant(base(), 'subConfig.sub1', 'set', ['buyer', 'social']).subConfig?.sub1).toEqual(
      ['buyer', 'social']
    ),
  'subConfig.sub2': () =>
    expect(assistant(base(), 'subConfig.sub2', 'remove', 'creative').subConfig?.sub2).toEqual([
      'social',
      'adAccountSuffix'
    ]),
  'subConfig.sub3': () =>
    expect(assistant(base(), 'subConfig.sub3', 'clear', null).subConfig?.sub3).toEqual([]),
  launchDate: () => {
    expect(assistant(base(), 'launchDate', 'set', 'today').launchDate).toBe('2026-11-21');
    expect(assistant(base(), 'launchDate', 'set', '2026-12-01').launchDate).toBe('2026-12-01');
  },
  'catalog.copyVideoToR2': () => {
    const on = assistant(base(), 'catalog.copyVideoToR2', 'set', true);
    expect(on.catalog).toEqual({ ...base().catalog!, copyVideoToR2: true });
    expect(assistant(on, 'catalog.copyVideoToR2', 'set', false).catalog?.copyVideoToR2).toBe(false);
    expect(
      applyAssistantChange(
        { ...base(), method: 'other' },
        { field: 'catalog.copyVideoToR2', op: 'set', value: true },
        ctx()
      )
    ).toEqual({
      ok: false,
      code: 'NOT_CATALOG'
    });
  },
  'catalog.restitchEnabled': () => {
    expect(assistant(base(), 'catalog.restitchEnabled', 'set', true).catalog?.restitchEnabled).toBe(
      true
    );
  }
};

describe('064 assistant ↔ form parity', () => {
  for (const [field, check] of Object.entries(CASES)) it(`stores ${field} as the form does`, check);

  it('has a parity case for every field opened to the assistant', () => {
    expect(assistantFieldPaths().filter(path => !(path in CASES))).toEqual([]);
  });
});
