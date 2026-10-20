import { describe, expect, it } from 'vitest';
import {
  parseTeamAccountOrderResult,
  reorderTeamAccountIds
} from '../packages/shared/src/team/account-order';
import {
  nextTeamAccountNameColor,
  parseTeamAccountArchivePreflight,
  parseTeamAccountLifecycleResult,
  parseTeamAccountNameColorResult,
  type TeamAccountNameColor
} from '../packages/shared/src/team/account-lifecycle';
import { parseTeamAccountsOverview } from '../packages/shared/src/team/account-overview';
import { sortTeamAccounts, sortTeamAgents } from '../packages/shared/src/team/accounts';

const archivedAt = '2026-10-18T06:00:00.000Z';
const preflight = {
  entityId: 'rk-a',
  entityKind: 'agent',
  lifecycleVersion: '4',
  token: 'preflight-proof',
  archivedAt: null,
  effectiveArchived: false,
  childCount: 0
};
const receipt = { ...preflight, operationId: 'operation', requestId: 'attempt' };
const colorReceipt = {
  operationId: 'color-operation',
  requestId: 'color-attempt',
  agentId: 'rk-a',
  color: 0,
  version: '0'
};
const orderReceipt = {
  operationId: 'order-operation',
  requestId: 'order-attempt',
  version: '0',
  order: ['rk-c', 'rk-a', 'rk-b']
};
const account = {
  id: 'social-a',
  team_id: 'team',
  name: 'g1',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: archivedAt,
  sort_rank: 2,
  lifecycle_version: '4',
  archived_at: null,
  agents: [
    {
      id: 'rk-a',
      account_id: 'social-a',
      team_id: 'team',
      agent_id: '99001',
      runs: [],
      balance: 0,
      topup: null,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: archivedAt,
      sort_rank: 1,
      lifecycle_version: '3',
      archived_at: archivedAt,
      name_color: 7,
      name_color_version: '8'
    }
  ]
};
const overview = {
  schemaVersion: 1,
  accounts: [account],
  socialOrderVersion: '2',
  agentOrderVersions: { 'social-a': '3' },
  coverage: 'complete'
};
const launch = {
  id: 'launch-a',
  agentRowId: 'rk-a',
  accountId: 'social-a',
  revisionId: 'revision-a',
  launchDate: '2026-10-18',
  workStatus: 'ready',
  hasResult: true,
  creativeAlias: 'test-creative',
  method: 'catalog',
  unmatchedReason: null
};

describe('manual order receipts and full-scope insertion', () => {
  it('keeps the complete membership and hidden rows in relative order in both directions', () => {
    const ids = ['visible-a', 'hidden-a', 'visible-b', 'hidden-b', 'visible-c'];
    const before = reorderTeamAccountIds(ids, 'visible-c', 'visible-a', 'before');
    const after = reorderTeamAccountIds(ids, 'visible-a', 'visible-c', 'after');
    expect(before).toEqual(['visible-c', 'visible-a', 'hidden-a', 'visible-b', 'hidden-b']);
    expect(after).toEqual(['hidden-a', 'visible-b', 'hidden-b', 'visible-c', 'visible-a']);
    for (const result of [before!, after!]) {
      expect([...result].sort()).toEqual([...ids].sort());
      expect(result.filter(id => id.startsWith('hidden'))).toEqual(['hidden-a', 'hidden-b']);
    }
    expect(ids).toEqual(['visible-a', 'hidden-a', 'visible-b', 'hidden-b', 'visible-c']);
    expect(reorderTeamAccountIds(ids, 'visible-a', 'hidden-a', 'before')).toEqual(ids);
  });

  it.each([
    { ids: ['a', 'b'], moved: 'a', anchor: 'a' },
    { ids: ['a', 'b'], moved: 'missing', anchor: 'b' },
    { ids: ['a', 'b'], moved: 'a', anchor: 'missing' },
    { ids: ['a', 'b', 'a'], moved: 'a', anchor: 'b' },
    { ids: [], moved: 'a', anchor: 'b' }
  ])('refuses an ambiguous or outdated scope %j', ({ ids, moved, anchor }) => {
    expect(reorderTeamAccountIds(ids, moved, anchor, 'after')).toBeNull();
  });

  it('parses acknowledged order without dropping any full-scope member', () => {
    expect(parseTeamAccountOrderResult(orderReceipt)).toEqual(orderReceipt);
    expect(parseTeamAccountOrderResult({ ...orderReceipt, order: [] })?.order).toEqual([]);
  });

  it.each([
    null,
    [],
    { ...orderReceipt, operationId: 1 },
    { ...orderReceipt, requestId: null },
    { ...orderReceipt, version: 1 },
    { ...orderReceipt, order: 'a,b' },
    { ...orderReceipt, order: ['a', 1] },
    { ...orderReceipt, order: ['a', 'a'] }
  ])('rejects malformed order acknowledgements %j', value => {
    expect(parseTeamAccountOrderResult(value)).toBeNull();
  });

  it('manual ranks win over renamed accounts and changed RK occupancy', () => {
    const accounts = [
      { name: 'g2', sortRank: 2 },
      { name: 'g90', sortRank: 1 }
    ];
    expect(sortTeamAccounts(accounts).map(row => row.name)).toEqual(['g90', 'g2']);
    const agents = [
      { agentId: 'renamed', sortRank: 2, runs: [] },
      {
        agentId: 'z',
        sortRank: 1,
        runs: [{ id: 'run', note: 'busy', marker: null, createdAt: '' }]
      }
    ];
    expect(sortTeamAgents(agents).map(row => row.agentId)).toEqual(['z', 'renamed']);
    expect(agents[0]!.agentId).toBe('renamed');
  });
});

describe('lifecycle and decorative-color write boundaries', () => {
  it('preserves own archive versus inherited parent archive in preflight and receipts', () => {
    expect(parseTeamAccountArchivePreflight(preflight)).toEqual(preflight);
    const inherited = { ...receipt, effectiveArchived: true, archivedAt: null };
    expect(parseTeamAccountLifecycleResult(inherited)).toMatchObject({
      archivedAt: null,
      effectiveArchived: true
    });
    const ownArchive = { ...receipt, archivedAt, effectiveArchived: true };
    expect(parseTeamAccountLifecycleResult(ownArchive)).toEqual(ownArchive);
    expect(
      parseTeamAccountArchivePreflight({
        ...preflight,
        entityKind: 'social',
        childCount: 5,
        archivedAt
      })
    ).toMatchObject({ entityKind: 'social', childCount: 5, archivedAt });
  });

  it.each([
    null,
    [],
    { ...preflight, entityId: 1 },
    { ...preflight, entityKind: 'account' },
    { ...preflight, lifecycleVersion: 0 },
    { ...preflight, token: null },
    { ...preflight, archivedAt: false },
    { ...preflight, archivedAt: 'bad-date' },
    { ...preflight, effectiveArchived: 'false' },
    { ...preflight, childCount: '0' },
    { ...preflight, childCount: 0.5 },
    { ...preflight, childCount: -1 },
    { ...preflight, childCount: NaN }
  ])('refuses unsafe lifecycle preflight %j', value => {
    expect(parseTeamAccountArchivePreflight(value)).toBeNull();
    expect(parseTeamAccountLifecycleResult(value)).toBeNull();
  });

  it.each([preflight, { ...receipt, operationId: null }, { ...receipt, requestId: 1 }])(
    'does not claim a lifecycle write without an operation receipt %j',
    value => {
      expect(parseTeamAccountLifecycleResult(value)).toBeNull();
    }
  );

  it('cycles exactly seven decorative colors and the uncolored state', () => {
    let color: TeamAccountNameColor = 0;
    const cycle = [];
    for (let step = 0; step < 8; step++) {
      color = nextTeamAccountNameColor(color);
      cycle.push(color);
    }
    expect(cycle).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
    expect(parseTeamAccountNameColorResult(colorReceipt)).toEqual(colorReceipt);
    expect(parseTeamAccountNameColorResult({ ...colorReceipt, color: 7 })?.color).toBe(7);
  });

  it.each([
    null,
    [],
    { ...colorReceipt, operationId: 1 },
    { ...colorReceipt, requestId: null },
    { ...colorReceipt, agentId: false },
    { ...colorReceipt, color: '1' },
    { ...colorReceipt, color: 0.5 },
    { ...colorReceipt, color: -1 },
    { ...colorReceipt, color: 8 },
    { ...colorReceipt, version: 0 }
  ])('rejects color state outside the private eight-state contract %j', value => {
    expect(parseTeamAccountNameColorResult(value)).toBeNull();
  });
});

describe('overview trust boundary and correlated launch summaries', () => {
  it('preserves zero, own lifecycle state, ranks and personal decoration without inventing launches', () => {
    const parsed = parseTeamAccountsOverview(overview)!;
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      socialOrderVersion: '2',
      accounts: [
        {
          sortRank: 2,
          agents: [{ balance: 0, topup: null, archivedAt, sortRank: 1, nameColor: 7 }]
        }
      ]
    });
    expect(parsed).not.toHaveProperty('launchSummaries');
    expect(parsed).not.toHaveProperty('launchCoverage');
    expect(
      parseTeamAccountsOverview({ ...overview, accounts: [], coverage: 'partial' })
    ).toMatchObject({
      accounts: [],
      coverage: 'partial'
    });
  });

  it.each([
    null,
    [],
    { ...overview, schemaVersion: 2 },
    { ...overview, accounts: null },
    { ...overview, accounts: [null] },
    {
      ...overview,
      accounts: [{ ...account, agents: [{ ...account.agents[0], account_id: 'other' }] }]
    },
    { ...overview, socialOrderVersion: 1 },
    { ...overview, agentOrderVersions: [] },
    { ...overview, agentOrderVersions: { 'social-a': 1 } },
    { ...overview, coverage: 'unknown' },
    { ...overview, launchSummaries: {} },
    { ...overview, launchCoverage: 'unknown' }
  ])('does not report a complete overview for malformed source data %j', value => {
    expect(parseTeamAccountsOverview(value)).toBeNull();
  });

  it('accepts matched, missing and unknown launches while keeping coverage explicitly partial', () => {
    const summaries = [
      launch,
      {
        ...launch,
        id: 'missing',
        agentRowId: null,
        accountId: null,
        revisionId: null,
        launchDate: null,
        hasResult: false,
        unmatchedReason: 'missing_agent'
      },
      { ...launch, id: 'unknown', unmatchedReason: 'unknown_agent' }
    ];
    expect(
      parseTeamAccountsOverview({
        ...overview,
        launchSummaries: summaries,
        launchCoverage: 'partial'
      })
    ).toMatchObject({
      launchSummaries: summaries,
      launchCoverage: 'partial'
    });
    expect(
      parseTeamAccountsOverview({ ...overview, launchSummaries: [], launchCoverage: 'complete' })
    ).toMatchObject({
      launchSummaries: [],
      launchCoverage: 'complete'
    });
  });

  it.each([
    null,
    { ...launch, id: 1 },
    { ...launch, agentRowId: 1 },
    { ...launch, accountId: false },
    { ...launch, revisionId: {} },
    { ...launch, launchDate: 20261018 },
    { ...launch, launchDate: '18/10/2026' },
    { ...launch, workStatus: null },
    { ...launch, hasResult: 'true' },
    { ...launch, creativeAlias: undefined },
    { ...launch, method: 1 },
    { ...launch, unmatchedReason: 'guessed_by_name' }
  ])('rejects incomplete or ambiguous launch evidence %j', value => {
    expect(parseTeamAccountsOverview({ ...overview, launchSummaries: [value] })).toBeNull();
  });
});

describe('decimal CAS version consistency across read and write seams', () => {
  it.each(['', '-1', '1.2', 'NaN', '1e3', ' 1', '9'.repeat(20)])(
    'rejects invalid version %s before it can seed a follow-up mutation',
    version => {
      expect(parseTeamAccountOrderResult({ ...orderReceipt, version })).toBeNull();
      expect(
        parseTeamAccountArchivePreflight({ ...preflight, lifecycleVersion: version })
      ).toBeNull();
      expect(parseTeamAccountNameColorResult({ ...colorReceipt, version })).toBeNull();
      expect(parseTeamAccountsOverview({ ...overview, socialOrderVersion: version })).toBeNull();
      expect(
        parseTeamAccountsOverview({ ...overview, agentOrderVersions: { 'social-a': version } })
      ).toBeNull();
    }
  );

  it.each(['0', '0002', '9'.repeat(19)])(
    'retains supported decimal version %s without precision loss',
    version => {
      expect(parseTeamAccountOrderResult({ ...orderReceipt, version })?.version).toBe(version);
      expect(
        parseTeamAccountArchivePreflight({ ...preflight, lifecycleVersion: version })
          ?.lifecycleVersion
      ).toBe(version);
      expect(parseTeamAccountNameColorResult({ ...colorReceipt, version })?.version).toBe(version);
      expect(
        parseTeamAccountsOverview({
          ...overview,
          socialOrderVersion: version,
          agentOrderVersions: { 'social-a': version }
        })
      ).toMatchObject({
        socialOrderVersion: version,
        agentOrderVersions: { 'social-a': version }
      });
    }
  );
});
