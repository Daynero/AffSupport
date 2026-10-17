import { describe, expect, it } from 'vitest';
import {
  parseLaunchDetail,
  parseLaunchDraft,
  parseLaunchGeneration,
  parseLaunchPreview,
  parseLaunchRevision,
  parseLaunchSummary
} from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';

const sourceSnapshot = {
  ...launchSources,
  schemaVersion: 1,
  agentRowId: launchConfig().agentRowId,
  offerId: launchConfig().offerId,
  buyerId: launchConfig().buyerId,
  materialId: launchConfig().materialId,
  catalogSettingsVersion: null
};

const preview = {
  advertisingUrl: 'https://example.invalid/?sub1=buyer',
  subValues: { sub1: 'buyer', sub2: null, sub3: null },
  campaigns: [{ ordinal: 1, budget: 10, adStart: 1, adEnd: 3, name: 'Campaign 1' }]
};
const revision = {
  id: 'revision',
  revisionNo: 1,
  kind: 'generated',
  generationId: 'generation',
  config: launchConfig(),
  sources: sourceSnapshot,
  baselineRevisionId: null,
  baseline: preview,
  overrides: {},
  catalog: null,
  createdAt: '2026-10-15T00:00:00Z'
};
const generation = {
  id: 'generation',
  state: 'running',
  stage: 'catalog_creating',
  stateVersion: '1',
  progress: { completed: 1, total: 3, unit: 'items', source: 'worker' },
  errorCode: null,
  childOperationIds: ['child']
};

describe('Launch persisted transport boundary', () => {
  it('parses protected detail with revision, catalog receipt and measured generation', () => {
    const detail = {
      id: 'launch',
      version: '2',
      draft: { originalUrl: 'https://example.invalid/?secret=SYNTHETIC', campaignCount: 3 },
      expectedSourceSnapshot: null,
      assigneeId: null,
      workStatus: 'in_progress',
      activeRevision: {
        ...revision,
        catalog: {
          id: 'catalog',
          materialId: 'material',
          variant: 1,
          name: 'Catalog',
          url: 'https://example.invalid/sheet',
          restitchMaterialId: null
        }
      },
      generation
    };
    expect(parseLaunchDetail(detail)).toMatchObject(detail);
    expect(
      parseLaunchDetail({ ...detail, activeRevision: { ...revision, catalog: { url: 4 } } })
    ).toBeNull();
    expect(
      parseLaunchDetail({
        ...detail,
        generation: { ...generation, progress: { ...generation.progress, completed: 4 } }
      })
    ).toBeNull();
    expect(
      parseLaunchDetail({
        ...detail,
        draft: { originalUrl: 'safe', unknownSecretField: 'SYNTHETIC' }
      })
    ).toBeNull();
  });

  it('rejects malformed stored drafts, previews and override payloads', () => {
    expect(
      parseLaunchDraft({
        budgets: [10, 20],
        gender: 'ALL',
        method: 'catalog',
        advantagePlus: false
      })
    ).toMatchObject({ budgets: [10, 20] });
    expect(parseLaunchDraft({ budgets: [10, Infinity] })).toBeNull();
    expect(
      parseLaunchDraft({ subConfig: { schemaVersion: 1, sub1: ['bogus'], sub2: [], sub3: [] } })
    ).toBeNull();
    expect(parseLaunchPreview(preview)).toEqual(preview);
    expect(
      parseLaunchPreview({ ...preview, campaigns: [{ ...preview.campaigns[0], adEnd: 0 }] })
    ).toBeNull();
    expect(
      parseLaunchPreview({ ...preview, subValues: { sub1: 1, sub2: null, sub3: null } })
    ).toBeNull();
    expect(parseLaunchRevision(revision)).toMatchObject(revision);
    expect(parseLaunchRevision({ ...revision, generationId: { secret: 'SYNTHETIC' } })).toBeNull();
    expect(
      parseLaunchRevision({
        ...revision,
        overrides: { campaigns: { 4: { name: 'wrong ordinal' } } }
      })
    ).toBeNull();
  });

  it('keeps list summaries bounded to their projection and rejects invalid states', () => {
    const summary = {
      id: 'launch',
      version: '1',
      launchDate: '2026-10-15',
      offer: 'Offer',
      social: 'g1',
      creativeAlias: 'v1',
      method: 'other',
      workStatus: 'todo',
      assigneeId: null,
      budgets: [10, 20],
      generationState: null,
      hasResult: false,
      gender: 'M',
      age: 45,
      campaignCount: 2,
      advantagePlus: false
    };
    expect(parseLaunchSummary(summary)).toEqual(summary);
    expect(parseLaunchSummary({ ...summary, budgets: [10, 10.5] })).toBeNull();
    expect(parseLaunchSummary({ ...summary, generationState: 'made_up' })).toBeNull();
    expect(parseLaunchSummary({ ...summary, workStatus: 'archived' })).toBeNull();
    expect(parseLaunchGeneration({ ...generation, childOperationIds: ['child', 2] })).toBeNull();
  });
});
