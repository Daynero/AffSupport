import type { LaunchConfig, LaunchSources } from '../../packages/shared/src/team/launches.js';
import type { TeamAccountSummary } from '../../packages/shared/src/team/index.js';

/** Synthetic identities shared by UI, ACL, date and provider-failure scenarios. */
export function launchFixtureWorld() {
  const firstTeam = '75000000-0000-4000-8000-000000000002';
  const secondTeam = '76000000-0000-4000-8000-000000000002';
  return {
    teams: {
      first: {
        id: firstTeam,
        owner: '75000000-0000-4000-8000-000000000001',
        editor: '75000000-0000-4000-8000-000000000004',
        viewer: '75000000-0000-4000-8000-000000000005'
      },
      second: {
        id: secondTeam,
        owner: '76000000-0000-4000-8000-000000000001',
        editor: '76000000-0000-4000-8000-000000000004',
        viewer: '76000000-0000-4000-8000-000000000005'
      }
    },
    accounts: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        teamId: firstTeam,
        social: 'g1',
        agentRowId: '11111111-1111-4111-8111-111111111111',
        externalId: '1234567892'
      },
      {
        id: '55555555-5555-4555-8555-555555555556',
        teamId: firstTeam,
        social: 'g2',
        agentRowId: '11111111-1111-4111-8111-111111111112',
        externalId: '9876543892'
      },
      {
        id: '55555555-5555-4555-8555-555555555557',
        teamId: secondTeam,
        social: 'g1',
        agentRowId: '11111111-1111-4111-8111-111111111113',
        externalId: '1234567892'
      }
    ],
    materials: {
      videoV1: { id: '44444444-4444-4444-8444-444444444444', version: '1', type: 'video' },
      videoV2: { id: '44444444-4444-4444-8444-444444444444', version: '2', type: 'video' },
      image: { id: '44444444-4444-4444-8444-444444444445', version: '1', type: 'image' }
    },
    calendar: { beforeDst: '2026-03-28', afterDst: '2026-03-30', yearEnd: '2026-12-31' },
    rawUrls: {
      duplicate: 'https://example.invalid/?sub1=old&token=SYNTHETIC_TOKEN&sub1=again#part',
      encodedKey: 'https://example.invalid/?%73ub1=untouched&SUB1=untouched&sub1=old'
    },
    childOutcomes: ['succeeded', 'failed', 'canceled', 'interrupted'] as const
  };
}

export function launchFixtureAccounts(): TeamAccountSummary[] {
  const world = launchFixtureWorld();
  return world.accounts
    .filter(account => account.teamId === world.teams.first.id)
    .map(account => ({
      id: account.id,
      name: account.social,
      agents: [{ id: account.agentRowId, agentId: account.externalId }]
    })) as TeamAccountSummary[];
}
export const launchConfig = (overrides: Partial<LaunchConfig> = {}): LaunchConfig => ({
  schemaVersion: 1,
  agentRowId: '11111111-1111-4111-8111-111111111111',
  offerId: '22222222-2222-4222-8222-222222222222',
  buyerId: '33333333-3333-4333-8333-333333333333',
  materialId: '44444444-4444-4444-8444-444444444444',
  creativeAlias: 'v5',
  campaignCount: 3,
  maxBudget: 30,
  adsCount: 3,
  budgetMode: 'auto',
  budgets: null,
  age: 45,
  gender: 'M',
  advantagePlus: false,
  launchDate: '2026-10-13',
  timezone: 'Europe/Kyiv',
  method: 'other',
  originalUrl: 'https://example.invalid/?pixel=token&x={{campaign.id}}',
  subConfig: {
    schemaVersion: 1,
    sub1: ['buyer'],
    sub2: ['social', 'adAccountSuffix', 'creative'],
    sub3: ['creative']
  },
  catalog: {
    productCount: 100,
    restitchEnabled: false,
    finalDurationMode: 'random-30-40',
    customFinalDurationSeconds: null
  },
  ...overrides
});
export const launchSources: LaunchSources = {
  accountId: '55555555-5555-4555-8555-555555555555',
  social: 'g1',
  agentId: '1234567892',
  offer: 'ProCaps TR',
  buyer: 'patrik',
  materialVersion: '1',
  materialType: 'video'
};

import type { DriveFileMetadata } from '../../supabase/functions/_shared/drive';
export function launchDriveMetadata(): DriveFileMetadata {
  return {
    id: 'sheet',
    name: 'Catalog',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    parents: ['parent'],
    trashed: false,
    driveId: null,
    ownedByMe: true,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    size: null,
    modifiedAt: null,
    checksum: null,
    version: '1',
    webViewLink: null,
    appProperties: { 'soty.catalog.intent': 'intent' },
    capabilities: {
      canDownload: true,
      canListChildren: false,
      canAddChildren: false,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canShare: true,
      canTrash: true,
      canUntrash: true
    }
  };
}
