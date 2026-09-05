import { describe, expect, it } from 'vitest';
import {
  countTeamAccounts,
  filterTeamAccounts,
  isTeamAgentFree,
  normalizeTeamAccountName,
  normalizeTeamAgentId,
  normalizeTeamAgentNote,
  parseTeamAccount,
  parseTeamAccountAgent,
  parseTeamTaskAgentTags,
  sortTeamAccounts,
  teamTaskAgentTagLabel,
  teamAccountTag,
  teamAgentIdSuffix,
  teamAgentLabel,
  type TeamAccountSummary
} from '@video-compressor/shared';

/**
 * The accounts contract (017): the normalizers every write goes through, the
 * parser every read goes through, and the two derived facts the list is built
 * on — free/busy and the `[name-suffix]` tag a task will carry.
 */

const TEAM = '17000000-0000-4000-8000-000000000001';

function agent(
  accountId: string,
  agentId: string,
  note: string | null,
  index: number
): TeamAccountSummary['agents'][number] {
  const id = `${accountId.slice(0, -2)}${String(index).padStart(2, '0')}`;
  return {
    id,
    accountId,
    teamId: TEAM,
    agentId,
    runs: note === null ? [] : [{ id: `${id}-run`, note, createdAt: '2026-09-05T10:00:00.000Z' }],
    taskCount: 0,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z'
  };
}

function account(id: string, name: string, agents: [string, string | null][]): TeamAccountSummary {
  return {
    id,
    teamId: TEAM,
    name,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    agents: agents.map(([agentId, note], index) => agent(id, agentId, note, index))
  };
}

const V3 = '17000000-0000-4000-8000-000000000300';
const V12 = '17000000-0000-4000-8000-000000001200';
const V31 = '17000000-0000-4000-8000-000000003100';

const SPACE: TeamAccountSummary[] = [
  account(V31, 'v31', [
    ['1000098765434', 'Pro Caps | TR 02/09'],
    ['1000098765401', null]
  ]),
  account(V3, 'v3', [
    ['1000011122211', 'Slim Fit | DE 01/09'],
    ['1000011122252', null]
  ]),
  account(V12, 'v12', [['2000000000901', 'Keto | PL 03/09']])
];

describe('normalizers', () => {
  it('accepts a name with its whitespace collapsed and refuses brackets', () => {
    expect(normalizeTeamAccountName('  v31 ')).toBe('v31');
    expect(normalizeTeamAccountName('Main   BM')).toBe('Main BM');
    // Brackets would break the tag's own delimiters.
    expect(normalizeTeamAccountName('[v31]')).toBeNull();
    expect(normalizeTeamAccountName('')).toBeNull();
    expect(normalizeTeamAccountName('x'.repeat(41))).toBeNull();
    expect(normalizeTeamAccountName(31)).toBeNull();
  });

  it('accepts an id as a single token only', () => {
    expect(normalizeTeamAgentId(' 1000098765434 ')).toBe('1000098765434');
    expect(normalizeTeamAgentId('act_abc-123')).toBe('act_abc-123');
    // Two things pasted, not one.
    expect(normalizeTeamAgentId('1000 0987')).toBeNull();
    expect(normalizeTeamAgentId('')).toBeNull();
    expect(normalizeTeamAgentId('9'.repeat(65))).toBeNull();
  });

  it('treats a blank note as no note, and refuses one that is too long', () => {
    expect(normalizeTeamAgentNote(null)).toBeNull();
    expect(normalizeTeamAgentNote('   ')).toBeNull();
    expect(normalizeTeamAgentNote(' Pro Caps  |  TR 02/09 ')).toBe('Pro Caps | TR 02/09');
    expect(normalizeTeamAgentNote('x'.repeat(121))).toBeUndefined();
    expect(normalizeTeamAgentNote(42)).toBeUndefined();
  });
});

describe('the visible tail and the tag', () => {
  it('shows the last three characters, or all of a shorter id', () => {
    expect(teamAgentIdSuffix('1000098765434')).toBe('434');
    expect(teamAgentIdSuffix('42')).toBe('42');
  });

  it('builds the label and the tag a task will carry from the name and the tail', () => {
    expect(teamAgentLabel('v31', '1000098765434')).toBe('v31-434');
    expect(teamAccountTag('v31', '1000098765434')).toBe('[v31-434]');
  });
});

describe('parsing what the server returns', () => {
  it('maps an agent row with its runs, dropping a blank one', () => {
    const parsed = parseTeamAccountAgent({
      id: 'a',
      account_id: 'b',
      team_id: TEAM,
      agent_id: '1000098765434',
      runs: [
        { id: 'r1', note: 'Pro Caps | TR 02/09', created_at: '2026-09-05T10:00:00.000Z' },
        { id: 'r2', note: '   ', created_at: '2026-09-05T10:00:00.000Z' }
      ],
      created_at: '2026-09-05T10:00:00.000Z',
      updated_at: '2026-09-05T10:00:00.000Z'
    });
    expect(parsed?.runs.map(run => run.note)).toEqual(['Pro Caps | TR 02/09']);
    expect(parsed && isTeamAgentFree(parsed)).toBe(false);
  });

  it('refuses an agent nested under the wrong account', () => {
    const row = {
      id: V31,
      team_id: TEAM,
      name: 'v31',
      created_at: '2026-09-05T10:00:00.000Z',
      updated_at: '2026-09-05T10:00:00.000Z',
      agents: [
        {
          id: 'a',
          account_id: V3,
          team_id: TEAM,
          agent_id: '1',
          runs: [],
          created_at: '2026-09-05T10:00:00.000Z',
          updated_at: '2026-09-05T10:00:00.000Z'
        }
      ]
    };
    expect(parseTeamAccount(row)).toBeNull();
    expect(parseTeamAccount({ ...row, agents: null })).toMatchObject({ agents: [] });
    expect(parseTeamAccount({ ...row, agents: 'nope' })).toBeNull();
  });
});

describe('ordering, counting and filtering', () => {
  it('sorts accounts naturally, so v3 comes before v12 and v31', () => {
    expect(sortTeamAccounts(SPACE).map(item => item.name)).toEqual(['v3', 'v12', 'v31']);
  });

  it('counts agents by occupancy', () => {
    expect(countTeamAccounts(SPACE)).toEqual({ accounts: 3, agents: 5, free: 2, busy: 3 });
  });

  it('keeps only free agents and drops an account with none', () => {
    const free = filterTeamAccounts(SPACE, { occupancy: 'free', search: '' });
    expect(free.map(item => [item.name, item.agents.length])).toEqual([
      ['v31', 1],
      ['v3', 1]
    ]);
    expect(free.every(item => item.agents.every(agent => agent.runs.length === 0))).toBe(true);
  });

  it('keeps an account with no agents under "free" but not under "running"', () => {
    const withEmpty = [...SPACE, account('17000000-0000-4000-8000-000000009900', 'v99', [])];
    expect(
      filterTeamAccounts(withEmpty, { occupancy: 'free', search: '' }).map(item => item.name)
    ).toEqual(['v31', 'v3', 'v99']);
    expect(
      filterTeamAccounts(withEmpty, { occupancy: 'busy', search: '' }).map(item => item.name)
    ).toEqual(['v31', 'v3', 'v12']);
    // A search that does not name it still hides it: there is nothing inside to match.
    expect(
      filterTeamAccounts(withEmpty, { occupancy: 'free', search: 'v3' }).map(item => item.name)
    ).toEqual(['v31', 'v3']);
  });

  it('keeps only running agents the other way round', () => {
    const busy = filterTeamAccounts(SPACE, { occupancy: 'busy', search: '' });
    expect(busy.map(item => [item.name, item.agents.length])).toEqual([
      ['v31', 1],
      ['v3', 1],
      ['v12', 1]
    ]);
  });

  it('matches a search against the name, the full id and the run', () => {
    // The name matches whole: every agent stays.
    expect(filterTeamAccounts(SPACE, { occupancy: 'all', search: 'V31' })).toHaveLength(1);
    expect(filterTeamAccounts(SPACE, { occupancy: 'all', search: 'v31' })[0]?.agents).toHaveLength(
      2
    );
    // An id or a run matches one agent: only it stays.
    const byId = filterTeamAccounts(SPACE, { occupancy: 'all', search: '765401' });
    expect(byId).toHaveLength(1);
    expect(byId[0]?.agents.map(agent => agent.agentId)).toEqual(['1000098765401']);
    const byRun = filterTeamAccounts(SPACE, { occupancy: 'all', search: 'keto' });
    expect(byRun.map(item => item.name)).toEqual(['v12']);
    expect(filterTeamAccounts(SPACE, { occupancy: 'all', search: 'nothing' })).toEqual([]);
  });

  it('applies the search and the occupancy together', () => {
    const result = filterTeamAccounts(SPACE, { occupancy: 'free', search: 'v3' });
    // "v3" is a substring of "v31" too, so both names match; each keeps its one free agent.
    expect(result.map(item => [item.name, item.agents.length])).toEqual([
      ['v31', 1],
      ['v3', 1]
    ]);
  });
});

describe('tags on tasks (017, part 2)', () => {
  const raw = {
    id: 'link-1',
    agent_row_id: 'agent-1',
    account_id: V31,
    account_name: 'v31',
    agent_id: '1000098765434',
    runs: [{ id: 'r1', note: 'Pro Caps | TR 02/09', created_at: '2026-09-05T10:00:00.000Z' }]
  };

  it('parses the tag list a task row carries, and reads no list as none', () => {
    expect(parseTeamTaskAgentTags([raw])).toEqual([
      {
        id: 'link-1',
        agentRowId: 'agent-1',
        accountId: V31,
        accountName: 'v31',
        agentId: '1000098765434',
        runs: [{ id: 'r1', note: 'Pro Caps | TR 02/09', createdAt: '2026-09-05T10:00:00.000Z' }]
      }
    ]);
    expect(parseTeamTaskAgentTags(null)).toEqual([]);
    expect(parseTeamTaskAgentTags(undefined)).toEqual([]);
    expect(parseTeamTaskAgentTags([{ ...raw, runs: null }])?.[0]?.runs).toEqual([]);
    expect(parseTeamTaskAgentTags([{ ...raw, agent_id: 7 }])).toBeNull();
    expect(parseTeamTaskAgentTags('nope')).toBeNull();
  });

  it('labels a tag exactly as the accounts list would', () => {
    const [tag] = parseTeamTaskAgentTags([raw]) ?? [];
    expect(tag && teamTaskAgentTagLabel(tag)).toBe('v31-434');
  });

  it('reads an agent row with and without its task count', () => {
    const base = {
      id: 'a',
      account_id: 'b',
      team_id: TEAM,
      agent_id: '1',
      runs: [],
      created_at: '2026-09-05T10:00:00.000Z',
      updated_at: '2026-09-05T10:00:00.000Z'
    };
    expect(parseTeamAccountAgent(base)?.taskCount).toBe(0);
    expect(parseTeamAccountAgent({ ...base, task_count: 3 })?.taskCount).toBe(3);
    expect(parseTeamAccountAgent({ ...base, task_count: -1 })).toBeNull();
  });
});
