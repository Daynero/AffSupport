import { parseLaunchSummary } from '../packages/shared/src/team/launches/persistence';
import { describe, expect, it } from 'vitest';
import {
  countTeamAccounts,
  filterTeamAccounts,
  getTeamAgentAvailability,
  isTeamAgentFree,
  parseTeamAccountAgent,
  parseTeamAgentAvailability,
  parseTeamTaskAgentTag,
  type TeamAccountAgentSummary,
  type TeamAccountSummary,
  type TeamAgentAvailability
} from '../packages/shared/src/team/accounts';
import { parseTeamAccountsOverview } from '../packages/shared/src/team/account-overview';
import {
  parseLaunchAssignmentReceipt,
  parseLaunchAssignmentState
} from '../packages/shared/src/team/launch-assignment';

function agent(availability?: TeamAgentAvailability): TeamAccountAgentSummary {
  return {
    id: 'rk',
    accountId: 'social',
    teamId: 'team',
    agentId: '123',
    runs: [],
    labels: [],
    balance: null,
    topup: null,
    taskCount: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...(availability ? { availability } : {})
  };
}
const free: TeamAgentAvailability = { status: 'free', assignmentCount: 0, legacyCount: 0 };
const busy: TeamAgentAvailability = { status: 'busy', assignmentCount: 3, legacyCount: 0 };
const unknown: TeamAgentAvailability = { status: 'unknown', assignmentCount: 0, legacyCount: 2 };
function account(agents: TeamAccountAgentSummary[]): TeamAccountSummary {
  return {
    id: 'social',
    teamId: 'team',
    name: 'Social',
    agents,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01'
  };
}
function rawAgent(availability?: unknown) {
  return {
    id: 'rk',
    account_id: 'social',
    team_id: 'team',
    agent_id: '123',
    runs: [],
    labels: [],
    balance: null,
    topup: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...(availability === undefined ? {} : { availability })
  };
}
describe('authoritative current RK availability', () => {
  it('validates complete assignment projections and rejects malformed authority', () => {
    const assignment = {
      id: 'launch',
      agentRowId: 'rk',
      accountId: 'social',
      revisionId: null,
      launchDate: '2026-10-29',
      workStatus: 'active',
      hasResult: false,
      creativeAlias: 'synthetic',
      method: 'catalog',
      unmatchedReason: null,
      assignmentState: 'assigned',
      assignmentVersion: '1'
    };
    const snapshot = {
      schemaVersion: 1,
      accounts: [],
      socialOrderVersion: '0',
      agentOrderVersions: {},
      coverage: 'complete',
      assignmentCoverage: 'complete',
      launchAssignments: [assignment]
    };
    expect(parseTeamAccountsOverview(snapshot)?.launchAssignments).toEqual([assignment]);
    for (const patch of [
      { assignmentState: 'released' },
      { assignmentVersion: 'invalid' },
      { assignmentVersion: '1'.repeat(20) },
      { launchDate: 'unknown' },
      { id: null }
    ]) {
      expect(
        parseTeamAccountsOverview({ ...snapshot, launchAssignments: [{ ...assignment, ...patch }] })
      ).toBeNull();
    }
    expect(parseTeamAccountsOverview({ ...snapshot, assignmentCoverage: 'unknown' })).toBeNull();
  });
  it('uses all current assignments, with no date, work-status, result or displayed-launch dependency', () => {
    expect(getTeamAgentAvailability(agent(busy))).toBe('busy');
    expect(isTeamAgentFree(agent(busy))).toBe(false);
    expect(getTeamAgentAvailability(agent(free))).toBe('free');
    expect(getTeamAgentAvailability(agent(unknown))).toBe('unknown');
    expect(isTeamAgentFree(agent(unknown))).toBe(false);
  });
  it('does not confuse date-filtered or truncated launch display with complete current availability', () => {
    const overview = parseTeamAccountsOverview({
      schemaVersion: 1,
      socialOrderVersion: '0',
      agentOrderVersions: {},
      coverage: 'complete',
      accounts: [
        {
          id: 'social',
          team_id: 'team',
          name: 'Social',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          agents: [rawAgent(busy)]
        }
      ],
      launchSummaries: [],
      launchCoverage: 'partial',
      launchAssignments: []
    });
    expect(overview).not.toBeNull();
    expect(overview!.assignmentCoverage).toBe('partial');
    expect(getTeamAgentAvailability(overview!.accounts[0]!.agents[0]!)).toBe('busy');
    expect(countTeamAccounts(overview!.accounts)).toMatchObject({ free: 0, busy: 1 });
  });
  it('keeps manual holds busy even with no assignment or unavailable authority', () => {
    for (const availability of [free, unknown]) {
      const row = agent(availability);
      row.runs = [{ id: 'hold', note: 'manual', marker: null, createdAt: '2026-01-01' }];
      expect(getTeamAgentAvailability(row)).toBe('busy');
    }
  });
  it('never reads missing or malformed wire authority as confirmed free', () => {
    const row = parseTeamAccountAgent(rawAgent());
    expect(row).not.toBeNull();
    expect(getTeamAgentAvailability(row!)).toBe('unknown');
    expect(
      parseTeamAccountAgent(rawAgent({ status: 'free', assignmentCount: 2, legacyCount: 0 }))
    ).toBeNull();
    expect(
      parseTeamAccountAgent(rawAgent({ status: 'unknown', assignmentCount: 1, legacyCount: 0 }))
    ).toBeNull();
    expect(
      parseTeamAgentAvailability({ status: 'free', assignmentCount: 0.5, legacyCount: 0 })
    ).toBeNull();
    expect(
      parseTeamAgentAvailability({ status: 'free', assignmentCount: 0, legacyCount: -1 })
    ).toBeNull();
    expect(parseTeamAccountAgent(rawAgent(free))?.availability).toEqual(free);
  });
  it('keeps unknown separate from both free and busy in shared counts and filters', () => {
    const rows = [
      account([
        { ...agent(free), id: 'free' },
        { ...agent(busy), id: 'busy' },
        { ...agent(unknown), id: 'unknown' }
      ])
    ];
    expect(countTeamAccounts(rows)).toMatchObject({ agents: 3, free: 1, busy: 1, unknown: 1 });
    for (const occupancy of ['free', 'busy', 'unknown'] as const)
      expect(
        filterTeamAccounts(rows, { occupancy, search: '' })[0]?.agents.map(row => row.id)
      ).toEqual([occupancy]);
    expect(filterTeamAccounts(rows, { occupancy: 'all', search: '' })[0]?.agents).toHaveLength(3);
  });
  it('does not claim availability from legacy task tags without authority', () => {
    const tag = parseTeamTaskAgentTag({
      id: 'tag',
      agent_row_id: 'rk',
      account_id: 'social',
      account_name: 'Social',
      agent_id: '123',
      runs: []
    });
    expect(tag).not.toBeNull();
    expect(getTeamAgentAvailability(tag!)).toBe('unknown');
  });
  it('keeps empty active socials available under Free without fabricating a free RK', () => {
    const rows = [account([])];
    expect(filterTeamAccounts(rows, { occupancy: 'free', search: '' })).toEqual(rows);
    expect(countTeamAccounts(rows)).toMatchObject({ accounts: 1, agents: 0, free: 0, busy: 0 });
  });
});

describe('Launch assignment receipt boundary', () => {
  const state = {
    launchId: 'launch',
    version: '2',
    state: 'assigned',
    agentRowId: 'rk',
    sourceAgentRowId: 'old-rk'
  };
  it('keeps current assignment separate from immutable historical source', () => {
    expect(parseLaunchAssignmentState(state)).toEqual(state);
    const released = { ...state, version: '3', state: 'released', agentRowId: null };
    expect(parseLaunchAssignmentState(released)).toEqual(released);
    expect(
      parseLaunchAssignmentReceipt({ ...released, operationId: 'operation', requestKey: 'request' })
    ).toEqual({ ...released, operationId: 'operation', requestKey: 'request' });
  });
  it('rejects missing receipts, impossible active states, unknown enums and malformed versions', () => {
    expect(parseLaunchAssignmentReceipt(state)).toBeNull();
    expect(parseLaunchAssignmentState({ ...state, agentRowId: null })).toBeNull();
    expect(parseLaunchAssignmentState({ ...state, state: 'released' })).toBeNull();
    expect(parseLaunchAssignmentState({ ...state, state: 'done' })).toBeNull();
    expect(parseLaunchAssignmentState({ ...state, version: '-1' })).toBeNull();
    expect(parseLaunchAssignmentState({ ...state, sourceAgentRowId: 3 })).toBeNull();
  });
});

describe('Launch list assignment projection', () => {
  const summary = {
    id: 'launch',
    version: '2',
    launchDate: '2026-10-26',
    offer: 'Offer',
    social: 'Social',
    creativeAlias: 'Creative',
    method: 'other',
    workStatus: 'todo',
    assigneeId: null,
    budgets: [10],
    generationState: null
  };
  const assignment = {
    launchId: 'launch',
    version: '3',
    state: 'released',
    agentRowId: null,
    sourceAgentRowId: 'old-rk'
  };
  it('retains operational assignment alongside historical source for Launch cards', () => {
    expect(parseLaunchSummary({ ...summary, assignment })?.assignment).toEqual(assignment);
    const old = parseLaunchSummary(summary);
    expect(old).not.toBeNull();
    expect(old).not.toHaveProperty('assignment');
  });
  it('does not turn an old manual-only free flag into authoritative availability', () => {
    expect(parseLaunchSummary({ ...summary, agentFree: true })?.agentFree).toBeUndefined();
    expect(parseLaunchSummary({ ...summary, agentFree: false })?.agentFree).toBe(false);
  });
  it('refuses malformed or cross-launch assignment data rather than dropping its authority', () => {
    expect(parseLaunchSummary({ ...summary, assignment: null })).toBeNull();
    expect(
      parseLaunchSummary({ ...summary, assignment: { ...assignment, state: 'running' } })
    ).toBeNull();
    expect(
      parseLaunchSummary({ ...summary, assignment: { ...assignment, launchId: 'other' } })
    ).toBeNull();
    expect(
      parseLaunchSummary({
        ...summary,
        assignment: { ...assignment, state: 'assigned', agentRowId: null }
      })
    ).toBeNull();
  });
});
